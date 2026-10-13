// 视频任务：流式分片接收、单任务 HEVC 转码、存储与草稿生命周期。
import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, readdir, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { TMP_DIR, db, getSetting, setSetting } from './db.js'
import { configValue } from './config.js'
import { requireAuth } from './auth.js'
import { activeBackend, putFileFromTemp, deleteImage, reserveMediaName, releaseMediaName, storeNewMedia } from './storage.js'
import { mediaDateParts, uploadTime } from './media-path.js'
import { enterOperation, isMaintenance } from './maintenance.js'

const MiB = 1024 * 1024
const CHUNK_BYTES = 8 * MiB
const RETENTION_MS = 60 * 60 * 1000
const MAX_FRAME_RATE = 60
const ACTIVE = new Set(['receiving', 'queued', 'compressing', 'saving'])
const TYPES = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-m4v': '.mp4' }
const PRESETS = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'])
const jobs = new Map()
let running = false

function numberConfig(key, fallback, min, max) {
  const value = Number(configValue(key, fallback))
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 配置应在 ${min}–${max} 之间`)
  return value
}
const MAX_BYTES = Math.trunc(numberConfig('media.maxVideoBytes', 2 * 1024 * MiB, 1, Number.MAX_SAFE_INTEGER))
const THREADS = Math.trunc(numberConfig('media.videoThreads', 2, 1, 16))
const MAX_JOBS = Math.trunc(numberConfig('media.videoMaxJobs', 8, 1, 32))
const CRF = numberConfig('media.videoCrf', 26, 0, 51)
const PRESET = String(configValue('media.videoPreset', 'fast'))
if (!PRESETS.has(PRESET)) throw new Error('media.videoPreset 配置无效')
const FFMPEG = String(configValue('media.ffmpegPath', 'ffmpeg'))
const FFPROBE = String(configValue('media.ffprobePath', 'ffprobe'))
function filename(ext, time) {
  const p = mediaDateParts(time)
  return reserveMediaName(() => `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${randomBytes(4).toString('hex')}${ext}`)
}
function fail(message, status = 400) { return Object.assign(new Error(message), { status }) }
function settings() {
  const mib = Number(getSetting('video_mib_per_minute', String(configValue('media.videoMiBPerMinute', 30))))
  if (!Number.isFinite(mib) || mib < 10 || mib > 100) throw new Error('视频每分钟目标体积应在 10–100MiB 之间')
  return { enabled: getSetting('video_compress_enabled', String(configValue('media.videoCompression', true))) === 'true', mibPerMinute: mib }
}

// 不经过 shell；输出有界，取消/超时均终止子进程并等待 close，避免清理与写文件竞争。
function command(program, args, { signal, timeout = 30000, onOutput } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errorOutput = '', reason = null, forceTimer = null
    const stop = (error) => {
      reason ||= error
      child.kill('SIGTERM')
      forceTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000)
      forceTimer.unref()
    }
    const abort = () => stop(fail('视频任务已取消'))
    const timer = setTimeout(() => stop(fail('视频处理超时，请缩短视频后重试')), timeout)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      if (onOutput) onOutput(chunk.toString())
      else if (output.length + chunk.length > 2 * MiB) stop(fail('视频信息过大，无法处理'))
      else output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk.toString()).slice(-4000) })
    child.on('error', (error) => { reason = error })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      signal?.removeEventListener('abort', abort)
      if (reason) reject(reason)
      else if (code !== 0) reject(fail(`视频处理失败：${errorOutput.trim().slice(-800) || `退出码 ${code}`}`))
      else resolve(output)
    })
  })
}

async function initialize() {
  // 浏览器离开不会终止任务；服务器重启造成的中断须明确记录，不能一直显示处理中。
  for (const row of db.prepare("SELECT * FROM video_jobs WHERE status IN ('receiving', 'queued', 'compressing', 'saving')").all()) {
    const job = restoreJob(row)
    job.status = job.phase = 'failed'
    job.error = '服务器重启中断了视频处理，请重新选择视频'
    job.finishedAt = Date.now()
    await cleanStored(job)
    persistJob(job)
  }
  // 仅回收本模块命名的临时文件；重启前的内存会话不能继续使用。
  for (const name of await readdir(TMP_DIR)) {
    if (/^vjob-[a-f0-9-]{36}\.(source|output\.mp4|poster\.jpg)$/.test(name)) await unlink(path.join(TMP_DIR, name))
  }
  try {
    const [encoders, filters] = await Promise.all([
      command(FFMPEG, ['-hide_banner', '-encoders']), command(FFMPEG, ['-hide_banner', '-filters']),
      command(FFPROBE, ['-version']),
    ])
    for (const encoder of ['libx265', 'aac', 'mjpeg']) {
      if (!new RegExp(`\\b${encoder}\\b`).test(encoders)) throw new Error(`FFmpeg 缺少 ${encoder} 编码器`)
    }
    for (const filter of ['scale', 'fps', 'zscale', 'tonemap']) {
      if (!new RegExp(`\\b${filter}\\b`).test(filters)) throw new Error(`FFmpeg 缺少 ${filter} 滤镜`)
    }
    return { available: true, error: '' }
  } catch (error) {
    console.warn(`视频工具不可用：${error.message}`)
    return { available: false, error: '需要安装包含 libx265、AAC、zscale 和 tonemap 的 FFmpeg / ffprobe' }
  }
}
const ready = (() => {
  const release = enterOperation('media')
  return initialize().finally(release)
})()
// 文件清理失败也转成显式不可用状态，避免模块初始化产生未处理拒绝。
const tools = ready.catch((error) => ({ available: false, error: `视频临时目录清理失败：${error.message}` }))

function draftActive(job) {
  return !job.draftId || Boolean(db.prepare("SELECT 1 FROM drafts WHERE id = ? AND user_id = ? AND status = 'active'").get(job.draftId, job.userId))
}
function assertActive(job) {
  job.controller.signal.throwIfAborted()
  if (!draftActive(job)) throw fail('草稿已结束，请重新上传视频', 409)
}
function referenced(name) {
  return Boolean(name && db.prepare('SELECT 1 FROM images WHERE filename = ? OR motion_filename = ? OR poster_filename = ? LIMIT 1').get(name, name, name))
}
function updateEncodingProgress(job, seconds, speed, now = Date.now()) {
  if (Number.isFinite(seconds) && seconds >= 0) {
    job.processedSeconds = Math.max(job.processedSeconds || 0, Math.min(job.duration, seconds))
    job.progress = Math.min(99, job.processedSeconds / job.duration * 100)
  }
  if (Number.isFinite(speed) && speed > 0) job.encodingSpeed = job.encodingSpeed ? job.encodingSpeed * .7 + speed * .3 : speed
  const elapsed = (now - job.encodingStartedAt) / 1000
  const rate = job.encodingSpeed || (elapsed > 0 ? job.processedSeconds / elapsed : 0)
  job.estimatedRemainingMs = rate > 0 && job.processedSeconds > 0
    ? Math.max(0, Math.round((job.duration - job.processedSeconds) / rate * 1000)) : null
}
function view(job) {
  const end = job.finishedAt || Date.now()
  const result = {
    uploadId: job.id, status: job.status, phase: job.phase || job.status, received: job.received,
    originalSize: job.received, total: job.total, progress: job.progress || 0,
    size: job.size || 0, duration: job.duration || null, budgetBytes: job.budgetBytes || 0,
    message: job.message || '', backend: job.backend,
    name: job.name || '', needsPoster: job.needsPoster,
    createdAt: job.createdAt, queuedAt: job.queuedAt || null, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    elapsedMs: job.startedAt ? Math.max(0, end - job.startedAt) : 0,
    totalElapsedMs: Math.max(0, end - job.createdAt),
    estimatedRemainingMs: ['compressing', 'remuxing'].includes(job.phase) ? job.estimatedRemainingMs ?? null : null,
  }
  if (job.status === 'done') Object.assign(result, { filename: job.filename, url: `/uploads/${job.filename}`, poster: job.poster || '', codec: job.codec })
  if (job.error) result.error = job.error
  return result
}
function persistJob(job) {
  const snapshot = JSON.stringify({ ...view(job), stored: job.stored, storageTime: job.storageTime,
    storagePath: job.storagePath, posterStoragePath: job.posterStoragePath,
    lastChunk: job.lastChunk, needsPoster: job.needsPoster })
  db.prepare(`INSERT INTO video_jobs (id, user_id, draft_id, status, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, snapshot = excluded.snapshot, updated_at = excluded.updated_at`)
    .run(job.id, job.userId, job.draftId, job.status, snapshot, job.createdAt, Date.now())
}
function restoreJob(row) {
  const state = JSON.parse(row.snapshot)
  const createdAt = uploadTime(state.createdAt ?? row.created_at)
  return { ...state, id: row.id, userId: row.user_id, draftId: row.draft_id, status: row.status, createdAt,
    controller: new AbortController(), storageTime: uploadTime(state.storageTime ?? createdAt),
    stored: (state.stored || []).map((file) => typeof file === 'string' ? { filename: file, storagePath: file } : file),
    source: path.join(TMP_DIR, `vjob-${row.id}.source`), output: path.join(TMP_DIR, `vjob-${row.id}.output.mp4`),
    posterPath: path.join(TMP_DIR, `vjob-${row.id}.poster.jpg`) }
}
function findJob(id, userId) {
  const live = jobs.get(id)
  if (live) return live.userId === userId ? live : null
  const row = db.prepare('SELECT * FROM video_jobs WHERE id = ? AND user_id = ?').get(id, userId)
  return row ? restoreJob(row) : null
}
export async function draftVideoJobs(userId, draftId) {
  await tools
  return db.prepare('SELECT * FROM video_jobs WHERE user_id = ? AND draft_id = ? ORDER BY created_at').all(userId, draftId)
    .map((row) => view(jobs.get(row.id) || restoreJob(row)))
}
async function cleanTemp(job) {
  for (const file of [job.source, job.output, job.posterPath]) {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}
async function cleanStored(job) {
  for (const file of [...job.stored]) {
    const name = file.filename
    if (referenced(name)) continue
    const pending = db.prepare('SELECT storage, storage_path FROM pending_uploads WHERE filename = ? AND user_id = ?').get(name, job.userId)
    const storagePath = file.storagePath || pending?.storage_path || name
    await deleteImage(name, pending?.storage || job.backend, storagePath)
    db.prepare('DELETE FROM pending_uploads WHERE filename = ? AND user_id = ?').run(name, job.userId)
    job.stored.splice(job.stored.indexOf(file), 1)
    persistJob(job)
  }
}
async function cancel(job) {
  if (referenced(job.filename)) throw fail('视频已发布，不能取消上传任务', 409)
  job.status = 'cancelled'
  job.phase = 'cancelled'
  job.controller.abort()
  await Promise.allSettled([job.receivingPromise, job.runPromise].filter(Boolean))
  job.status = job.phase = 'cancelled'
  job.error = ''
  await cleanStored(job)
  await cleanTemp(job)
  job.finishedAt ||= Date.now()
  persistJob(job)
  job.expiresAt = Date.now() + RETENTION_MS
}
export async function cancelDraftVideoJobs(userId, draftId) {
  await tools
  for (const row of db.prepare('SELECT * FROM video_jobs WHERE user_id = ? AND draft_id = ?').all(userId, draftId)) {
    const job = jobs.get(row.id) || restoreJob(row)
    if (!referenced(job.filename)) await cancel(job)
  }
}
async function cleanup() {
  if (isMaintenance()) return
  const release = enterOperation('media')
  try { await performCleanup() } finally { release() }
}
async function performCleanup() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.expiresAt > now) continue
    if (job.status === 'receiving') await cancel(job)
    if (!ACTIVE.has(job.status)) jobs.delete(id)
  }
  db.prepare(`DELETE FROM video_jobs WHERE updated_at < ? AND status NOT IN ('receiving', 'queued', 'compressing', 'saving')
    AND NOT EXISTS (SELECT 1 FROM drafts WHERE drafts.id = video_jobs.draft_id AND drafts.user_id = video_jobs.user_id AND drafts.status = 'active')`)
    .run(now - RETENTION_MS)
}
const cleanupTimer = setInterval(() => cleanup().catch((error) => console.warn(`清理视频任务失败：${error.message}`)), 60000)
cleanupTimer.unref()

async function createJob(userId, { draftId, contentType, size, needsPoster = true, name = '' }) {
  const capability = await tools
  if (!capability.available) throw fail(capability.error, 503)
  await cleanup()
  if (!TYPES[contentType]) throw fail('不支持的视频格式，请上传 MP4 / MOV / WebM')
  if (size !== null && (!Number.isSafeInteger(size) || size <= 0)) throw fail('视频大小无效')
  if (size > MAX_BYTES) throw fail(`原视频不能超过 ${(MAX_BYTES / MiB).toFixed(0)}MiB`, 413)
  if ([...jobs.values()].filter((job) => ACTIVE.has(job.status)).length >= MAX_JOBS) throw fail('视频任务已满，请等待当前视频处理完成', 429)
  const id = randomUUID()
  const createdAt = Date.now()
  const job = {
    id, userId, draftId: draftId || null, contentType, total: size, received: 0, status: 'receiving',
    source: path.join(TMP_DIR, `vjob-${id}.source`), output: path.join(TMP_DIR, `vjob-${id}.output.mp4`),
    posterPath: path.join(TMP_DIR, `vjob-${id}.poster.jpg`), needsPoster,
    name: String(name).slice(0, 255),
    settings: settings(), backend: activeBackend(), controller: new AbortController(), stored: [],
    createdAt, storageTime: uploadTime(createdAt),
    expiresAt: Date.now() + RETENTION_MS,
  }
  assertActive(job)
  // 在首次 await 写文件前登记，防止并行 init 越过任务配额。
  jobs.set(id, job)
  try {
    persistJob(job)
    await writeFile(job.source, '', { flag: 'wx' })
  } catch (error) {
    jobs.delete(id)
    db.prepare('DELETE FROM video_jobs WHERE id = ?').run(id)
    throw error
  }
  return job
}

async function receive(job, request, offset, limit = CHUNK_BYTES) {
  assertActive(job)
  if (!Number.isSafeInteger(offset) || offset < 0) throw fail('分片偏移无效')
  const duplicate = job.lastChunk?.offset === offset && offset < job.received
  if (job.busy || (job.status !== 'receiving' && (!duplicate || !['queued', 'compressing', 'saving', 'done'].includes(job.status)))) throw fail('任务暂时不能接收分片，请查询进度后重试', 409)
  if (offset !== job.received && !duplicate) throw fail('分片偏移不匹配，请查询已接收进度', 409)
  if (!request.body) throw fail('没有收到视频分片')
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > limit || (!duplicate && offset + declared > (job.total ?? MAX_BYTES))) throw fail('视频分片超过大小限制', 413)
  job.busy = true
  const work = async () => {
    let bytes = 0
    const hash = createHash('sha256')
    try {
      await pipeline(
        Readable.fromWeb(request.body),
        new Transform({ transform(chunk, _encoding, done) {
          bytes += chunk.length
          if (bytes > limit || (!duplicate && offset + bytes > (job.total ?? MAX_BYTES))) return done(fail('视频分片超过大小限制', 413))
          hash.update(chunk)
          done(null, chunk)
        } }),
        duplicate ? new Writable({ write(_chunk, _encoding, done) { done() } }) : createWriteStream(job.source, { flags: 'r+', start: offset }),
        { signal: job.controller.signal },
      )
      assertActive(job)
      if (!bytes || (declared && bytes !== declared)) throw fail('视频分片不完整，请重试')
      const digest = hash.digest('hex')
      if (duplicate) {
        if (bytes !== job.lastChunk.bytes || digest !== job.lastChunk.hash) throw fail('重复分片内容不一致', 409)
      } else {
        job.received += bytes
        job.lastChunk = { offset, bytes, hash: digest }
      }
      job.expiresAt = Date.now() + RETENTION_MS
      persistJob(job)
    } catch (error) {
      if (!duplicate) await truncate(job.source, offset).catch((e) => { if (e.code !== 'ENOENT') throw e })
      throw error
    } finally { job.busy = false }
  }
  job.receivingPromise = work()
  await job.receivingPromise
  // 最后分片落盘后由服务器自动入队，即使浏览器已关闭或响应丢失也会继续执行。
  if (job.total !== null && job.received === job.total && job.status === 'receiving') complete(job)
}

function ratio(value) {
  const [a, b = 1] = String(value || '').split('/').map(Number)
  return b ? a / b : 0
}
async function probe(file, signal) {
  const raw = await command(FFPROBE, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-show_format', '-show_streams', '-of', 'json', file], { signal })
  const info = JSON.parse(raw)
  if (!String(info.format?.format_name || '').split(',').some((name) => ['mov', 'mp4', 'matroska', 'webm'].includes(name))) throw fail('文件不是支持的视频容器')
  const video = info.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  if (!video?.width || !video?.height) throw fail('视频没有有效画面轨道')
  const duration = Number(info.format?.duration || video.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw fail('无法读取有效视频时长')
  const rotation = Number(video.side_data_list?.find((item) => item.rotation !== undefined)?.rotation || video.tags?.rotate || 0)
  const rotated = Math.abs(Math.round(rotation / 90)) % 2 === 1
  const width = rotated ? video.height : video.width
  const height = rotated ? video.width : video.height
  const rate = ratio(video.avg_frame_rate) || ratio(video.r_frame_rate)
  if (!Number.isFinite(rate) || rate <= 0) throw fail('无法读取有效视频帧率')
  return { ...info, video, duration, rotation, width, height, rate, audio: info.streams.filter((s) => s.codec_type === 'audio') }
}
function budget(duration, mibPerMinute) { return Math.max(MiB, Math.round(duration / 60 * mibPerMinute * MiB)) }
function hdrType(info) {
  if (info.video.side_data_list?.some((side) => /DOVI|Dolby/i.test(side.side_data_type || ''))) throw fail('无法正确处理此 Dolby Vision 色彩格式')
  const transfer = info.video.color_transfer
  if (['smpte2084', 'arib-std-b67'].includes(transfer)) {
    if (info.video.color_primaries !== 'bt2020' || !['bt2020nc', 'bt2020c'].includes(info.video.color_space)) throw fail('HDR 色彩信息不完整，无法正确转换')
    return true
  }
  if (transfer && !['unknown', 'bt709', 'smpte170m', 'bt470m', 'bt470bg', 'iec61966-2-1', 'smpte240m'].includes(transfer)) throw fail(`暂不支持此视频色彩传递格式：${transfer}`)
  return false
}

// 保留旋转后的原始像素尺寸；奇数边长仅补一像素以适配 4:2:0 编码。
function outputSize(info) {
  return { width: Math.ceil(info.width / 2) * 2, height: Math.ceil(info.height / 2) * 2 }
}
function compatible(info, size, target) {
  return info.video.codec_name === 'hevc' && ['yuv420p', 'yuvj420p'].includes(info.video.pix_fmt)
    && !hdrType(info) && info.rotation === 0 && info.rate <= MAX_FRAME_RATE
    && info.width % 2 === 0 && info.height % 2 === 0 && size <= target
    && info.audio.length <= 1 && info.audio.every((s) => s.codec_name === 'aac' && Number(s.channels) <= 2 && Number(s.bit_rate || 0) <= 132000)
}
function videoFilter(info) {
  const filters = []
  if (hdrType(info)) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv')
  const size = outputSize(info)
  filters.push(`pad=${size.width}:${size.height}`)
  if (info.rate > MAX_FRAME_RATE) filters.push(`fps=${MAX_FRAME_RATE}`)
  filters.push('format=yuv420p')
  return filters.join(',')
}
async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function faststart(file) {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const header = Buffer.alloc(16)
    let offset = 0
    for (let count = 0; count < 256 && offset + 8 <= size; count++) {
      const { bytesRead } = await handle.read(header, 0, 16, offset)
      if (bytesRead < 8) return false
      const type = header.toString('ascii', 4, 8)
      if (type === 'moov') return true
      if (type === 'mdat') return false
      const length = header.readUInt32BE(0)
      const atomSize = length === 1 && bytesRead >= 16 ? Number(header.readBigUInt64BE(8)) : length
      if (!Number.isSafeInteger(atomSize) || atomSize < 8 || offset + atomSize > size) return false
      offset += atomSize
    }
    return false
  } finally { await handle.close() }
}
async function store(job, name, file, type) {
  assertActive(job)
  const size = (await stat(file)).size
  const storagePath = await storeNewMedia(name, job.backend, job.storageTime,
    (relativePath, options) => putFileFromTemp(name, file, size, type, relativePath, job.backend, job.controller.signal, options))
  // 仅确认保存成功后登记；412 目标从不进入清理集合。
  job.stored.push({ filename: name, storagePath })
  if (name === job.filename) job.storagePath = storagePath
  else job.posterStoragePath = storagePath
  persistJob(job)
  assertActive(job)
  return size
}
async function processJob(job) {
  try {
    assertActive(job)
    job.status = 'compressing'
    job.phase = 'probing'
    job.startedAt = Date.now()
    persistJob(job)
    const info = await probe(job.source, job.controller.signal)
    job.duration = info.duration
    job.budgetBytes = budget(info.duration, job.settings.mibPerMinute)
    const expectedSize = outputSize(info)
    const canCopy = job.settings.enabled && compatible(info, job.received, job.budgetBytes)
    let finalFile = job.source
    let finalInfo = info
    if (job.settings.enabled) {
      const audioRate = info.audio.length ? 128000 : 0
      const maxRate = Math.max(100000, Math.floor((job.budgetBytes * 0.95 * 8 / info.duration - audioRate) / 1000) * 1000)
      const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-threads', String(THREADS), '-i', job.source,
        '-map', `0:${info.video.index}`, '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1']
      if (canCopy) args.push('-c', 'copy')
      else args.push('-vf', videoFilter(info), '-c:v', 'libx265', '-preset', PRESET, '-crf', String(CRF),
        '-threads', String(THREADS), '-filter_threads', String(THREADS),
        '-x265-params', `pools=${THREADS}:frame-threads=1:vbv-maxrate=${maxRate / 1000}:vbv-bufsize=${maxRate * 2 / 1000}:log-level=error`,
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        ...(hdrType(info) ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []))
      args.push('-tag:v', 'hvc1', '-movflags', '+faststart', '-progress', 'pipe:1', job.output)
      job.phase = canCopy ? 'remuxing' : 'compressing'
      job.encodingStartedAt = Date.now()
      persistJob(job)
      let progressBuffer = ''
      await command(FFMPEG, args, {
        signal: job.controller.signal, timeout: 6 * 60 * 60 * 1000,
        onOutput(chunk) {
          progressBuffer += chunk
          const lines = progressBuffer.split('\n')
          progressBuffer = lines.pop() || ''
          for (const line of lines) {
            if (line.startsWith('out_time_us=')) updateEncodingProgress(job, Number(line.slice(12)) / 1000000)
            if (line.startsWith('speed=')) updateEncodingProgress(job, undefined, Number(line.slice(6).trim().replace(/x$/, '')))
            if (line.startsWith('progress=') && Date.now() - (job.lastPersistAt || 0) >= 1000) {
              job.lastPersistAt = Date.now()
              persistJob(job)
            }
          }
        },
      })
      job.phase = 'validating'
      persistJob(job)
      finalInfo = await probe(job.output, job.controller.signal)
      if (finalInfo.video.codec_name !== 'hevc' || finalInfo.video.codec_tag_string !== 'hvc1'
        || finalInfo.rate > MAX_FRAME_RATE + 0.01 || finalInfo.width !== expectedSize.width
        || finalInfo.height !== expectedSize.height || finalInfo.rotation !== 0
        || !['yuv420p', 'yuvj420p'].includes(finalInfo.video.pix_fmt)
        || finalInfo.audio.some((stream) => stream.codec_name !== 'aac' || Number(stream.channels) > 2)
        || (hdrType(info) && finalInfo.video.color_transfer !== 'bt709')
        || finalInfo.audio.length !== (info.audio.length ? 1 : 0)
        || Math.abs(finalInfo.duration - info.duration) > Math.max(0.5, 2 / Math.min(info.rate, MAX_FRAME_RATE))) throw fail('压缩输出验证失败，未保存视频')
      finalFile = job.output
      job.message = canCopy ? '原视频已符合 HEVC 目标，仅优化 MP4 封装' : '已压缩为 H.265'
      if (canCopy && info.video.codec_tag_string === 'hvc1' && (await stat(job.output)).size > job.received && await faststart(job.source)) {
        finalFile = job.source
        finalInfo = info
        job.message = '原文件更小，且已符合 HEVC 播放要求，已保留原文件'
      }
    } else job.message = '自动压缩已关闭，已保留原视频'
    job.duration = finalInfo.duration
    assertActive(job)
    job.filename = filename(job.settings.enabled ? '.mp4' : TYPES[job.contentType], job.storageTime)
    job.codec = finalInfo.video.codec_name
    job.size = (await stat(finalFile)).size
    if (job.settings.enabled && job.size > job.received) job.message += '；为兼容播放转换，保存文件大于原文件'
    if (job.settings.enabled && job.size > job.budgetBytes * 1.05) job.message += '；实际大小超过参考预算'
    const hash = await hashFile(finalFile)
    if (job.needsPoster) {
      job.phase = 'poster'
      persistJob(job)
      await command(FFMPEG, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
        '-ss', String(Math.min(0.1, info.duration / 10)), '-i', finalFile, '-map', `0:${finalInfo.video.index}`,
        '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-threads', String(THREADS), job.posterPath], { signal: job.controller.signal })
      if (!(await stat(job.posterPath)).size) throw fail('视频封面生成失败')
      job.poster = filename('.jpg', job.storageTime)
    }
    job.status = 'saving'
    job.phase = 'saving'
    job.progress = 100
    persistJob(job)
    await store(job, job.filename, finalFile, job.settings.enabled ? 'video/mp4' : job.contentType)
    let posterHash = null
    if (job.poster) {
      posterHash = await hashFile(job.posterPath)
      await store(job, job.poster, job.posterPath, 'image/jpeg')
    }
    assertActive(job)
    const insert = db.prepare('INSERT INTO pending_uploads (filename, hash, storage, user_id, draft_id, storage_path) VALUES (?, ?, ?, ?, ?, ?)')
    db.exec('BEGIN')
    try {
      insert.run(job.filename, hash, job.backend, job.userId, job.draftId, job.storagePath)
      if (job.poster) insert.run(job.poster, posterHash, job.backend, job.userId, job.draftId, job.posterStoragePath)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    await cleanTemp(job)
    job.status = 'done'
    job.phase = 'done'
  } catch (error) {
    job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
    job.error = job.status === 'failed' ? error.message : ''
    await cleanStored(job).catch((e) => console.warn(`清理视频存储失败：${e.message}`))
    await cleanTemp(job).catch((e) => console.warn(`清理视频临时文件失败：${e.message}`))
    if (job.status === 'failed') console.warn(`视频任务 ${job.id} 失败：${error.message}`)
  } finally {
    releaseMediaName(job.filename)
    releaseMediaName(job.poster)
    job.finishedAt = Date.now()
    job.phase = job.status
    job.expiresAt = job.finishedAt + RETENTION_MS
    persistJob(job)
  }
}
async function drain() {
  if (running || isMaintenance()) return
  const release = enterOperation('media')
  running = true
  try {
    for (;;) {
      const job = [...jobs.values()].find((item) => item.status === 'queued')
      if (!job) break
      job.runPromise = processJob(job)
      await job.runPromise
    }
  } finally { running = false; release() }
}
function complete(job) {
  assertActive(job)
  if (job.status !== 'receiving') return // complete 可重复提交。
  if (job.busy || job.received <= 0 || (job.total !== null && job.received !== job.total)) throw fail('视频尚未完整接收', 409)
  job.total = job.received
  job.status = 'queued'
  job.queuedAt = Date.now()
  persistJob(job)
  void drain().catch((error) => console.warn(`视频队列执行失败：${error.message}`))
}

export const videoJobsApp = new Hono()
videoJobsApp.use('*', requireAuth)
videoJobsApp.use('*', async (_c, next) => { await tools; await next() })
videoJobsApp.onError((error, c) => c.json({ error: error.name === 'AbortError' ? '视频上传已取消' : error.message }, error.status || 500))
videoJobsApp.get('/config', async (c) => c.json({ ...settings(), ...(await tools), maxBytes: MAX_BYTES, chunkBytes: CHUNK_BYTES, codec: 'hevc', crf: CRF, preset: PRESET, threads: THREADS, maxFps: MAX_FRAME_RATE, resolution: 'original' }))
videoJobsApp.put('/config', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.enabled !== 'boolean' || !Number.isFinite(body.mibPerMinute) || body.mibPerMinute < 10 || body.mibPerMinute > 100) throw fail('请设置压缩开关及 10–100MiB 的每分钟目标体积')
  setSetting('video_compress_enabled', String(body.enabled))
  setSetting('video_mib_per_minute', String(body.mibPerMinute))
  return c.json({ ok: true, ...settings() })
})
videoJobsApp.post('/init', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || !Number.isSafeInteger(body.size)) throw fail('视频大小无效')
  const job = await createJob(c.get('user').id, { draftId: body.draftId, contentType: String(body.contentType || ''), size: body.size, needsPoster: body.needsPoster !== false, name: body.name })
  return c.json(view(job), 201)
})
// 兼容原来的整文件入口；代理仍可能限制此入口，因此新前端始终使用分片。
videoJobsApp.post('/', async (c) => {
  const length = c.req.header('content-length')
  const job = await createJob(c.get('user').id, { draftId: c.req.query('draftId'), contentType: String(c.req.header('content-type') || '').split(';')[0].trim().toLowerCase(), size: length ? Number(length) : null })
  try {
    await receive(job, c.req.raw, 0, MAX_BYTES)
    complete(job)
    return c.json({ ...view(job), status: 'saving', size: job.received }, 202)
  } catch (error) { await cancel(job); throw error }
})
videoJobsApp.use('/:id/*', async (c, next) => {
  const job = findJob(c.req.param('id'), c.get('user').id)
  if (!job || job.userId !== c.get('user').id) throw fail('上传任务不存在或已过期，请重新选择视频', 404)
  c.set('videoJob', job)
  await next()
})
videoJobsApp.get('/:id', (c) => {
  const job = findJob(c.req.param('id'), c.get('user').id)
  if (!job || job.userId !== c.get('user').id) throw fail('上传任务不存在或已过期，请重新选择视频', 404)
  return c.json(view(job))
})
videoJobsApp.post('/:id/chunk', async (c) => {
  const job = c.get('videoJob')
  const rawOffset = c.req.query('offset')
  if (!/^\d+$/.test(rawOffset || '')) throw fail('分片偏移无效')
  await receive(job, c.req.raw, Number(rawOffset))
  return c.json(view(job))
})
videoJobsApp.post('/:id/complete', (c) => { const job = c.get('videoJob'); complete(job); return c.json(view(job), 202) })
videoJobsApp.delete('/:id', async (c) => {
  const job = findJob(c.req.param('id'), c.get('user').id)
  if (!job || job.userId !== c.get('user').id) throw fail('上传任务不存在或已过期', 404)
  await cancel(job)
  return c.json({ ok: true })
})

export function videoJobsBusy() {
  return running || [...jobs.values()].some((job) => ACTIVE.has(job.status) || job.busy)
}

export async function resetVideoJobsAfterRestore() {
  if (videoJobsBusy()) throw fail('仍有视频任务未结束，无法清空恢复前任务状态', 409)
  for (const job of jobs.values()) await cleanTemp(job)
  // 只清理视频任务暂存，保留本地与 WebDAV 的正式媒体文件。
  for (const name of await readdir(TMP_DIR)) {
    if (/^vjob-[a-f0-9-]{36}\.(source|output\.mp4|poster\.jpg)$/.test(name)) {
      await unlink(path.join(TMP_DIR, name)).catch((error) => { if (error.code !== 'ENOENT') throw error })
    }
  }
  jobs.clear()
  running = false
}
