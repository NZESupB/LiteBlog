// 视频任务：持久化分片、版本化策略、阶段恢复与草稿生命周期。
import { Hono } from 'hono'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, readdir, stat, truncate, unlink, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { TMP_DIR, db, getSetting, setSetting } from './db.js'
import { configValue } from './config.js'
import { requireAuth } from './auth.js'
import { activeBackend, putFileFromTemp, deleteImage, reserveMediaName, releaseMediaName, verifyStoredFile } from './storage.js'
import { mediaDateParts, uploadTime, datedMediaPath, conflictMediaPath } from './media-path.js'
import { enterOperation, isMaintenance } from './maintenance.js'
import { VIDEO_POLICY_VERSION, VIDEO_PROFILES, MAX_FRAME_RATE, videoProfile } from './video-profile.js'
import { FFMPEG, command, baseOptions, inputOptions, detectVideoTools } from './video-encoder.js'
import { artifact, signature, hashFile, syncFile, nextGeneration } from './video-checkpoints.js'
import { probe, metrics, compatible, directContainer, hdrType, remuxVideo, encodeVideo } from './video-processing.js'
import { videoReferenced, originalReady, promotePublishedVideo } from './video-publication.js'

const MiB = 1024 ** 2
const CHUNK_BYTES = 8 * MiB
const RETENTION_MS = 24 * 60 * 60 * 1000
const ACTIVE = new Set(['receiving', 'queued', 'compressing', 'saving', 'comparing'])
const TYPES = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-m4v': '.mp4' }
const jobs = new Map()
let running = false, preparing = false, stopping = false
function numberConfig(key, fallback, min, max) {
  const value = Number(configValue(key, fallback))
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 配置应为 ${min}–${max} 的整数`)
  return value
}
const MAX_BYTES = numberConfig('media.maxVideoBytes', 2 * 1024 * MiB, 1, Number.MAX_SAFE_INTEGER)
const MAX_JOBS = numberConfig('media.videoMaxJobs', 8, 1, 32)
const settings = () => ({ enabled: getSetting('video_compress_enabled', String(configValue('media.videoCompression', true))) === 'true', version: VIDEO_POLICY_VERSION })
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
function filename(ext, time) {
  const p = mediaDateParts(time)
  return reserveMediaName(() => `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${randomBytes(4).toString('hex')}${ext}`)
}
function transaction(work) {
  db.exec('BEGIN')
  try { const result = work(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}
function referenced(name) {
  return Boolean(name && db.prepare('SELECT 1 FROM images WHERE filename = ? OR motion_filename = ? OR poster_filename = ? LIMIT 1').get(name, name, name))
}
function draftActive(job) {
  return !job.draftId || Boolean(db.prepare("SELECT 1 FROM drafts WHERE id = ? AND user_id = ? AND status = 'active'").get(job.draftId, job.userId))
}
function assertActive(job) {
  job.controller.signal.throwIfAborted()
  if (!draftActive(job) && !videoReferenced(job)) throw fail('草稿已结束且视频未被动态采用', 409)
}
function selectionReady(job) { return ['done', 'failed'].includes(job.status) || (job.retryable && job.phase === 'waiting') }
function publicVariant(variant) {
  if (!variant) return null
  return { ...variant, url: `/uploads/${variant.filename}` }
}
function view(job) {
  const now = job.finishedAt || Date.now()
  const variants = Object.fromEntries(Object.entries(job.variants || {}).map(([key, value]) => [key, publicVariant(value)]))
  const result = { uploadId: job.id, status: job.status, phase: job.phase || job.status, received: job.received, originalSize: job.received, total: job.total,
    size: job.size || 0, duration: job.duration || null, budgetBytes: job.profile?.budgetBytes || job.budgetBytes || 0,
    profile: job.profile || null, encoder: job.encoder?.name || '', passthrough: job.passthrough || '',
    progress: job.progress || 0, completedSegments: job.completedSegments || 0, segmentCount: job.segmentCount || 0,
    currentSegment: job.currentSegment || 0, completedSeconds: job.completedSeconds || 0,
    message: job.message || '', backend: job.backend, name: job.name || '', needsPoster: job.needsPoster,
    livePhoto: Boolean(job.livePhoto), originalReady: originalReady(job),
    compressionPending: Boolean(originalReady(job) && job.settings?.enabled && ACTIVE.has(job.status) && !job.retryable),
    clientUploadId: job.clientUploadId || '', fingerprint: job.identity?.fingerprint || '', expiresAt: job.expiresAt,
    variants, versions: variants, comparison: job.comparison || null, recommendedVariant: job.recommendedVariant || '', selectedVariant: job.selectedVariant || '',
    selectionSource: job.selectionSource || 'auto', selectionUpdatedAt: job.selectionUpdatedAt || 0,
    canSelect: originalReady(job) && draftActive(job) && !videoReferenced(job), fallbackAvailable: originalReady(job) && (job.status === 'failed' || Boolean(job.retryable)),
    createdAt: job.createdAt, queuedAt: job.queuedAt || null, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    elapsedMs: (job.processingMs || 0) + (job.attemptStartedAt ? Date.now() - job.attemptStartedAt : 0),
    totalElapsedMs: Math.max(0, now - job.createdAt), phaseElapsedMs: { ...(job.timings || {}), ...(job.phaseStartedAt ? { [job.phase]: (job.timings?.[job.phase] || 0) + Date.now() - job.phaseStartedAt } : {}) },
    estimatedRemainingMs: ['compressing', 'remuxing'].includes(job.phase) ? job.estimatedRemainingMs ?? null : null,
    retryable: Boolean(job.retryable), error: job.error || '' }
  const selected = job.variants?.[job.selectedVariant]
  if (selected?.filename || (job.status === 'done' && job.filename)) Object.assign(result, { filename: selected?.filename || job.filename, url: `/uploads/${selected?.filename || job.filename}`, poster: job.poster || '', codec: selected?.codec || job.codec || '' })
  return result
}
function persistJob(job) {
  const snapshot = { ...job }
  for (const key of ['controller', 'runPromise', 'cleanupPromise', 'receivingPromise', 'initializing', 'source', 'directory', 'capability', 'busy', 'attemptStartedAt', 'phaseStartedAt', 'generation']) delete snapshot[key]
  snapshot.processingMs = view(job).elapsedMs
  snapshot.timings = view(job).phaseElapsedMs
  db.prepare(`INSERT INTO video_jobs (id, user_id, draft_id, status, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, snapshot = excluded.snapshot, updated_at = excluded.updated_at`)
    .run(job.id, job.userId, job.draftId, job.status, JSON.stringify(snapshot), job.createdAt, Date.now())
}
function restoreJob(row) {
  if (!/^[a-f0-9-]{36}$/.test(row.id)) throw new Error('视频任务 ID 无效')
  const state = JSON.parse(row.snapshot)
  const createdAt = uploadTime(state.createdAt ?? row.created_at)
  const directory = path.join(TMP_DIR, `vjob-${row.id}`)
  const job = { ...state, id: row.id, userId: row.user_id, draftId: row.draft_id, status: row.status === 'awaiting' ? 'queued' : row.status, directory,
    source: state.schemaVersion === 2 ? path.join(directory, 'source') : path.join(TMP_DIR, `vjob-${row.id}.source`),
    createdAt, storageTime: uploadTime(state.storageTime ?? createdAt), expiresAt: state.expiresAt || Date.now() + RETENTION_MS,
    stored: (state.stored || []).map((file) => typeof file === 'string' ? { filename: file, storagePath: file } : file),
    timings: state.timings || {}, processingMs: state.processingMs || 0, controller: new AbortController(), capability: () => tools }
  job.originalReady = originalReady(job)
  if (job.originalReady && !job.selectedVariant) applySelection(job, 'original')
  return job
}
function findJob(id, userId) {
  const live = jobs.get(id)
  if (live) return live.userId === userId ? live : null
  const row = db.prepare('SELECT * FROM video_jobs WHERE id = ? AND user_id = ?').get(id, userId)
  return row ? restoreJob(row) : null
}
async function verifySource(job) {
  const size = (await stat(job.source)).size
  if (size < job.received) throw new Error('原件长度小于已确认上传记录，请取消后重新上传')
  if (size > job.received) { await truncate(job.source, job.received); await syncFile(job.source) }
  const chunks = db.prepare('SELECT * FROM video_chunks WHERE job_id = ? ORDER BY offset').all(job.id)
  let offset = 0
  for (const chunk of chunks) {
    if (chunk.offset !== offset || chunk.size <= 0 || await hashFile(job.source, { start: offset, end: offset + chunk.size - 1, signal: job.controller.signal }) !== chunk.hash) throw new Error('已确认分片缺失或损坏，请取消后重新上传')
    offset += chunk.size
  }
  if (chunks.length && offset !== job.received) throw new Error('上传分片记录不完整')
  if (!chunks.length && job.received > 0) {
    // 旧任务没有分片清单，只接受现有原件完整前缀，后续新分片继续逐片校验。
    for (let start = 0; start < job.received; start += CHUNK_BYTES) {
      const size = Math.min(CHUNK_BYTES, job.received - start)
      const hash = await hashFile(job.source, { start, end: start + size - 1, signal: job.controller.signal })
      db.prepare('INSERT INTO video_chunks (job_id, offset, size, hash) VALUES (?, ?, ?, ?)').run(job.id, start, size, hash)
    }
    job.message = '已验证旧任务原件；后续处理采用固定档位'
  }
}
async function initialize() {
  let capability
  try { capability = await detectVideoTools() }
  catch (error) { capability = { available: false, error: error.message, supported: [] }; console.warn(`视频工具不可用：${error.message}`) }
  for (const row of db.prepare('SELECT * FROM video_jobs ORDER BY created_at').all()) {
    const job = restoreJob(row)
    if (!ACTIVE.has(job.status)) {
      if (job.status === 'done') { await cleanTemp(job); if (videoReferenced(job)) await cleanStored(job) }
      continue
    }
    jobs.set(job.id, job)
    try {
      if ((!draftActive(job) || job.expiresAt < Date.now()) && !videoReferenced(job)) { await cancel(job); continue }
      await mkdir(job.directory, { recursive: true })
      if (job.received === 0) { const handle = await open(job.source, 'a'); await handle.close() }
      if (originalReady(job)) {
        const original = job.variants.original
        if (!await verifyStoredFile(original.filename, original.backend || job.backend, original.storagePath, original.size, original.hash, job.controller.signal)) {
          job.originalReady = false; original.available = false
          throw new Error('已保存的原件缺失或损坏，不能发布，请重新上传')
        }
      }
      await verifySource(job)
      if (!job.settings?.version && !job.profile) {
        job.settings = settings()
        job.contentType ||= 'video/mp4'
        job.message = '旧任务已验证原件，按固定档位重新开始处理'
      }
      job.error = ''; job.estimatedRemainingMs = null; job.encodingSpeed = null
      if (job.status !== 'receiving' || job.total === job.received) { job.status = 'queued'; job.phase = 'queued'; job.queuedAt ||= Date.now() }
      if (!capability.available && job.status === 'queued') { job.phase = 'waiting'; job.error = capability.error; job.retryable = true }
      persistJob(job)
    } catch (error) { job.status = job.phase = 'failed'; job.error = error.message; job.finishedAt = Date.now(); persistJob(job) }
  }
  // 只处理有持久化任务的目录；未知残留不冒充恢复成功，也不删除未确认所有权的文件。
  return capability
}
let tools
let cleanupTimer
export function startVideoJobs() {
  if (tools) return tools
  stopping = false
  const release = enterOperation('media')
  tools = initialize().finally(release)
  void tools.then(() => scheduleJobs()).catch((error) => console.warn(`恢复视频队列失败：${error.message}`))
  cleanupTimer = setInterval(() => cleanup().catch((error) => console.warn(`清理视频任务失败：${error.message}`)), 60000)
  cleanupTimer.unref()
  return tools
}

export async function draftVideoJobs(userId, draftId) {
  await tools
  return db.prepare('SELECT * FROM video_jobs WHERE user_id = ? AND draft_id = ? ORDER BY created_at').all(userId, draftId).map((row) => view(jobs.get(row.id) || restoreJob(row)))
}
async function cleanTemp(job) {
  await rm(job.directory, { recursive: true, force: true })
  for (const suffix of ['source', 'output.mp4', 'poster.jpg']) await unlink(path.join(TMP_DIR, `vjob-${job.id}.${suffix}`)).catch((error) => { if (error.code !== 'ENOENT') throw error })
}
function cleanStored(job) {
  if (job.cleanupPromise) return job.cleanupPromise
  job.cleanupPromise = performStoredCleanup(job).finally(() => { job.cleanupPromise = null })
  return job.cleanupPromise
}
async function performStoredCleanup(job) {
  for (const file of [...job.stored]) {
    if (referenced(file.filename)) continue
    const pending = db.prepare('SELECT * FROM pending_uploads WHERE filename = ?').get(file.filename)
    if (pending && (pending.user_id !== job.userId || (pending.draft_id || null) !== job.draftId)) continue
    const intent = job.storageIntents?.[file.filename]
    if (!pending && (!intent || !await verifyStoredFile(file.filename, job.backend, intent.path, intent.size, intent.hash, AbortSignal.timeout(120000)))) continue
    await deleteImage(file.filename, pending?.storage || job.backend, file.storagePath || pending?.storage_path || file.filename)
    db.prepare('DELETE FROM pending_uploads WHERE filename = ? AND user_id = ?').run(file.filename, job.userId)
    for (const variant of Object.values(job.variants || {})) if (variant.filename === file.filename) variant.available = false
    job.stored.splice(job.stored.indexOf(file), 1); persistJob(job)
  }
}
async function cancel(job) {
  if (videoReferenced(job)) throw fail('视频已发布，不能取消上传任务', 409)
  job.status = job.phase = 'cancelled'; job.controller.abort()
  await Promise.allSettled([job.receivingPromise, job.runPromise].filter(Boolean))
  job.status = job.phase = 'cancelled'; job.error = ''; job.retryable = false
  // 处理中途成功但未登记的写入，只在内容确认属于本任务时进入清理集合。
  for (const intent of Object.values(job.storageIntents || {})) {
    if (!job.stored.some((file) => file.storagePath === intent.path) && await verifyStoredFile(intent.name, job.backend, intent.path, intent.size, intent.hash, AbortSignal.timeout(120000))) job.stored.push({ filename: intent.name, storagePath: intent.path })
  }
  await cleanStored(job); await cleanTemp(job)
  db.prepare('DELETE FROM video_artifacts WHERE job_id = ?').run(job.id)
  job.finishedAt ||= Date.now(); job.expiresAt = Date.now() + RETENTION_MS; persistJob(job)
}
export async function cancelDraftVideoJobs(userId, draftId) {
  await tools
  const protectedJobs = []
  for (const row of db.prepare('SELECT * FROM video_jobs WHERE user_id = ? AND draft_id = ?').all(userId, draftId)) {
    const job = jobs.get(row.id) || restoreJob(row)
    if (!videoReferenced(job)) await cancel(job)
    else if (ACTIVE.has(job.status) || job.runPromise) protectedJobs.push(job)
    else await cleanStored(job)
  }
  // 等待其他任务取消后再取快照，包含等待期间新增的保存意图。
  return new Set(protectedJobs.flatMap((job) => [job.poster, job.originalFilename, job.compressedFilename,
    ...job.stored.map((file) => file.filename), ...Object.keys(job.storageIntents || {})]).filter(Boolean))
}
function jobForFilename(userId, name) {
  const row = db.prepare(`SELECT * FROM video_jobs WHERE user_id = ? AND
    (json_extract(snapshot, '$.variants.original.filename') = ? OR json_extract(snapshot, '$.variants.compressed.filename') = ?) LIMIT 1`).get(userId, name, name)
  return row ? jobs.get(row.id) || restoreJob(row) : null
}
export function assertVideoUploadSelected(userId, name) {
  const job = jobForFilename(userId, name)
  if (!job) return name
  const selected = job.variants?.[job.selectedVariant]
  if (job.status === 'cancelled' || selected?.available === false) throw fail('视频版本不可用，请刷新后重试', 409)
  const ready = job.status === 'done' || originalReady(job)
  if (ready && job.filename === name) return name
  // 自动采用在发布请求途中完成时，沿用当前版本，不把迟到的原件重新挂回动态。
  if (ready && selected && job.variants?.original?.filename === name && job.selectionSource !== 'user') return selected.filename
  throw fail('视频原件尚未就绪或版本已改变，请刷新后重试', 409)
}
export async function cleanupPublishedVideoVersions(userId, names) {
  const release = enterOperation('media')
  try {
    const seen = new Set()
    for (const name of names) {
      const job = jobForFilename(userId, name)
      if (!job || seen.has(job.id) || !videoReferenced(job)) continue
      seen.add(job.id)
      if (ACTIVE.has(job.status)) continue
      transaction(() => { promotePublishedVideo(job); persistJob(job) })
      await cleanStored(job)
    }
  } finally { release() }
}
async function cleanup() {
  if (isMaintenance() || stopping) return
  const release = enterOperation('media')
  try {
    for (const [id, job] of jobs) {
      if (job.expiresAt > Date.now() || job.runPromise || job.busy) continue
      if (videoReferenced(job)) {
        if (!ACTIVE.has(job.status)) { await cleanStored(job); jobs.delete(id) }
        continue
      }
      if (job.status !== 'done' && job.status !== 'cancelled') await cancel(job)
      if (!ACTIVE.has(job.status)) jobs.delete(id)
    }
    db.prepare(`DELETE FROM video_jobs WHERE updated_at < ? AND status NOT IN ('receiving', 'queued', 'compressing', 'saving', 'comparing')
      AND NOT EXISTS (SELECT 1 FROM images, json_each(json_array(json_extract(video_jobs.snapshot, '$.filename'),
        json_extract(video_jobs.snapshot, '$.variants.original.filename'), json_extract(video_jobs.snapshot, '$.variants.compressed.filename'))) AS media
        WHERE images.filename = media.value OR images.motion_filename = media.value OR images.poster_filename = media.value)
      AND NOT EXISTS (SELECT 1 FROM drafts WHERE drafts.id = video_jobs.draft_id AND drafts.user_id = video_jobs.user_id AND drafts.status = 'active')`).run(Date.now() - RETENTION_MS)
  } finally { release() }
}

function validateIdentity(body) {
  if (!body.fingerprint && !body.hashes) return null
  const hashes = body.hashes
  if (!Array.isArray(hashes) || hashes.length !== Math.ceil(body.size / CHUNK_BYTES) || hashes.length > Math.ceil(MAX_BYTES / CHUNK_BYTES)
    || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)) || body.chunkBytes !== CHUNK_BYTES) throw fail('文件分片指纹无效')
  const identity = { size: body.size, chunkBytes: CHUNK_BYTES, hashes }
  const fingerprint = signature(identity)
  if (body.fingerprint !== fingerprint) throw fail('文件身份校验失败')
  return { ...identity, fingerprint }
}
async function createJob(userId, body) {
  const capability = await tools
  if (!capability.available) throw fail(capability.error, 503)
  await cleanup()
  const { draftId, contentType, size, needsPoster = true, livePhoto = false, name = '', clientUploadId } = body
  if (typeof livePhoto !== 'boolean') throw fail('实况视频标记无效')
  if (!TYPES[contentType]) throw fail('不支持的视频格式，请上传 MP4 / MOV / WebM')
  if (size !== null && (!Number.isSafeInteger(size) || size <= 0)) throw fail('视频大小无效')
  if (size > MAX_BYTES) throw fail(`原视频不能超过 ${(MAX_BYTES / MiB).toFixed(0)}MiB`, 413)
  const identity = validateIdentity(body)
  if (clientUploadId) {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(clientUploadId)) throw fail('客户端上传标识无效')
    const key = db.prepare('SELECT job_id FROM video_upload_keys WHERE user_id = ? AND client_id = ?').get(userId, clientUploadId)
    if (key) {
      const existing = findJob(key.job_id, userId)
      if (existing.draftId !== (draftId || null) || existing.total !== size || existing.identity?.fingerprint !== identity?.fingerprint || existing.contentType !== contentType || existing.needsPoster !== needsPoster || Boolean(existing.livePhoto) !== livePhoto) throw fail('此上传标识已绑定另一文件或草稿', 409)
      if (existing.status === 'cancelled') throw fail('任务已取消，请新建上传', 410)
      await existing.initializing
      return existing
    }
  }
  if ([...jobs.values()].filter((job) => ACTIVE.has(job.status)).length >= MAX_JOBS) throw fail('视频任务已满，请等待当前视频处理完成', 429)
  const id = randomUUID(), createdAt = Date.now(), directory = path.join(TMP_DIR, `vjob-${id}`)
  const job = { id, schemaVersion: 2, userId, draftId: draftId || null, contentType, total: size, received: 0, status: 'receiving', phase: 'receiving',
    source: path.join(directory, 'source'), directory, identity, clientUploadId: clientUploadId || '', needsPoster, livePhoto, originalReady: false, name: String(name).slice(0, 255),
    settings: { ...settings(), ...(livePhoto ? { enabled: true } : {}) }, encoder: capability.encoder, backend: activeBackend(), controller: new AbortController(), stored: [],
    createdAt, storageTime: createdAt, expiresAt: createdAt + RETENTION_MS, timings: {}, processingMs: 0, capability: () => tools }
  assertActive(job); jobs.set(id, job)
  try {
    transaction(() => { persistJob(job); if (clientUploadId) db.prepare('INSERT INTO video_upload_keys (user_id, client_id, job_id) VALUES (?, ?, ?)').run(userId, clientUploadId, id) })
    job.initializing = (async () => { await mkdir(directory); await writeFile(job.source, '', { flag: 'wx' }); await syncFile(job.source); await syncFile(directory) })()
    await job.initializing
  } catch (error) { jobs.delete(id); db.prepare('DELETE FROM video_jobs WHERE id = ?').run(id); await cleanTemp(job); throw error }
  return job
}
async function receive(job, request, offset, limit = CHUNK_BYTES) {
  assertActive(job)
  if (!Number.isSafeInteger(offset) || offset < 0) throw fail('分片偏移无效')
  const duplicate = db.prepare('SELECT * FROM video_chunks WHERE job_id = ? AND offset = ?').get(job.id, offset)
  if (job.busy || (job.status !== 'receiving' && !duplicate)) throw fail('任务暂时不能接收分片，请查询进度后重试', 409)
  if (offset !== job.received && !duplicate) throw fail('分片偏移不匹配，请查询已接收进度', 409)
  if (!request.body) throw fail('没有收到视频分片')
  const expectedHash = job.identity?.hashes[offset / CHUNK_BYTES]
  if (job.identity && (!expectedHash || offset % CHUNK_BYTES !== 0)) throw fail('分片序号无效')
  const declared = Number(request.headers.get('content-length') || 0)
  const expectedSize = job.identity ? Math.min(CHUNK_BYTES, job.total - offset) : null
  if (declared > limit || (!duplicate && offset + declared > (job.total ?? MAX_BYTES))) throw fail('视频分片超过大小限制', 413)
  job.busy = true
  job.receivingPromise = (async () => {
    let bytes = 0
    const hash = createHash('sha256')
    try {
      await pipeline(Readable.fromWeb(request.body), new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length
        if (bytes > limit || (!duplicate && offset + bytes > (job.total ?? MAX_BYTES))) return done(fail('视频分片超过大小限制', 413))
        hash.update(chunk); done(null, chunk)
      } }), duplicate ? new Writable({ write(_chunk, _encoding, done) { done() } }) : createWriteStream(job.source, { flags: 'r+', start: offset }), { signal: job.controller.signal })
      assertActive(job)
      if (!bytes || (declared && bytes !== declared) || (expectedSize !== null && bytes !== expectedSize)) throw fail('视频分片不完整，请重试')
      const digest = hash.digest('hex')
      if ((expectedHash && digest !== expectedHash) || (duplicate && (bytes !== duplicate.size || digest !== duplicate.hash))) throw fail('分片内容与原文件不一致', 409)
      if (!duplicate) {
        await syncFile(job.source)
        const previous = job.received
        try { transaction(() => {
          db.prepare('INSERT INTO video_chunks (job_id, offset, size, hash) VALUES (?, ?, ?, ?)').run(job.id, offset, bytes, digest)
          job.received += bytes; job.expiresAt = Date.now() + RETENTION_MS; persistJob(job)
        }) } catch (error) { job.received = previous; throw error }
      }
    } catch (error) {
      if (!duplicate) { await truncate(job.source, offset); await syncFile(job.source) }
      throw error
    } finally { job.busy = false }
  })()
  await job.receivingPromise
  if (job.total !== null && job.received === job.total && job.status === 'receiving') complete(job)
}
export async function faststart(file) {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size, header = Buffer.alloc(16)
    let offset = 0
    for (let count = 0; count < 256 && offset + 8 <= size; count++) {
      if ((await handle.read(header, 0, 16, offset)).bytesRead < 8) return false
      const type = header.toString('ascii', 4, 8)
      if (type === 'moov') return true
      if (type === 'mdat') return false
      const length = header.readUInt32BE(0), atomSize = length === 1 ? Number(header.readBigUInt64BE(8)) : length
      if (!Number.isSafeInteger(atomSize) || atomSize < 8 || offset + atomSize > size) return false
      offset += atomSize
    }
    return false
  } finally { await handle.close() }
}
function setPhase(job, phase) {
  assertActive(job)
  const now = Date.now()
  if (job.phaseStartedAt) job.timings[job.phase] = (job.timings[job.phase] || 0) + now - job.phaseStartedAt
  job.phase = phase; job.phaseStartedAt = now
  if (!['compressing', 'remuxing'].includes(phase)) job.estimatedRemainingMs = null
  job.expiresAt = now + RETENTION_MS; persistJob(job)
}
async function saveOutput(job, name, file, type, hash) {
  const size = (await stat(file)).size
  job.storageIntents ||= {}
  let intent = job.storageIntents[name]
  if (!intent) {
    intent = { name, path: job.backend === 'webdav' ? datedMediaPath(name, job.storageTime) : name, size, hash, state: 'planned' }
    job.storageIntents[name] = intent; persistJob(job)
  }
  if (intent.size !== size || intent.hash !== hash) throw new Error('保存产物与持久化意图不一致')
  const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(30 * 60 * 1000)])
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      assertActive(job)
      if (intent.state !== 'planned' && await verifyStoredFile(name, job.backend, intent.path, size, hash, signal)) break
      intent.state = 'writing'; persistJob(job)
      try { await putFileFromTemp(name, file, size, type, intent.path, job.backend, signal, { exclusive: true }); break }
      catch (error) {
        if ((error.code === 'STORAGE_CONFLICT' || error.code === 'EEXIST') && await verifyStoredFile(name, job.backend, intent.path, size, hash, signal)) break
        if (error.code !== 'STORAGE_CONFLICT' || attempt === 2) throw error
        intent.path = conflictMediaPath(intent.path); intent.state = 'planned'; persistJob(job)
      }
    }
    intent.state = 'confirmed'
    if (!job.stored.some((entry) => entry.filename === name)) job.stored.push({ filename: name, storagePath: intent.path })
    persistJob(job); assertActive(job)
    return intent.path
  } catch (error) { error.retryable = true; throw error }
}
function registerMedia(work) {
  try { return transaction(work) } catch (error) { error.retryable = true; throw error }
}
function registerPending(job, name, hash, storagePath) {
  const existing = db.prepare('SELECT * FROM pending_uploads WHERE filename = ?').get(name)
  if (existing) {
    if (existing.user_id !== job.userId || (existing.draft_id || null) !== job.draftId || existing.hash !== hash || existing.storage !== job.backend || existing.storage_path !== storagePath) throw new Error('媒体登记与任务归属不一致')
    return
  }
  db.prepare('INSERT INTO pending_uploads (filename, hash, storage, user_id, draft_id, storage_path) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, hash, job.backend, job.userId, job.draftId, storagePath)
}
function applySelection(job, variant) {
  const selected = job.variants?.[variant]
  if (!selected || selected.available === false) throw fail('此视频版本不可用', 409)
  job.selectedVariant = variant
  Object.assign(job, { filename: selected.filename, storagePath: selected.storagePath, size: selected.size, codec: selected.codec || '', duration: selected.duration || job.duration })
}
function compareVersions(job) {
  const original = job.variants.original, compressed = job.variants.compressed
  const savingBytes = compressed ? original.size - compressed.size : 0
  const savingPercent = compressed ? savingBytes / original.size * 100 : 0
  job.recommendedVariant = compressed && (savingBytes > 0 || !original.playbackCompatible) ? 'compressed' : 'original'
  const reason = !compressed ? (job.passthrough === 'source' ? '原文件已符合目标，无需生成重复版本' : '保留已保存的原文件')
    : !original.playbackCompatible ? '原文件的播放格式需要转换，推荐经过验证的 MP4 版本'
      : savingBytes > 0 ? '压缩版本经过验证且体积更小' : '原文件适合播放且体积更小或相同'
  const changes = []
  if (compressed) {
    if (compressed.lossy) changes.push('经过有损编码；没有计算客观画质评分')
    if (original.hdr && !compressed.hdr) changes.push('HDR 转换为 SDR，色彩与亮度范围发生变化')
    if (original.width !== compressed.width || original.height !== compressed.height) changes.push('奇数尺寸补齐为偶数')
    if (Math.abs(original.rate - compressed.rate) > .1) changes.push(`帧率 ${original.rate.toFixed(2)} → ${compressed.rate.toFixed(2)}fps`)
    if (original.bitDepth !== compressed.bitDepth) changes.push(`编码位深 ${original.bitDepth} → ${compressed.bitDepth}bit；位深增加不代表细节恢复`)
    if (!compressed.lossy) changes.push('仅优化封装，视频码流未重新编码')
    if (compressed.size > (job.profile?.budgetBytes || Infinity) * 1.05) changes.push('实际体积超过参考预算')
  }
  job.comparison = { original, compressed: compressed || null, savingBytes, savingPercent,
    compressionRatio: compressed ? compressed.size / original.size : null, qualityScore: null, changes, reason }
  applySelection(job, job.selectionSource === 'user' && job.variants[job.selectedVariant] ? job.selectedVariant : job.recommendedVariant)
  job.message = reason
}
async function ensureOriginal(job, sourceHash) {
  job.variants ||= {}
  job.originalFilename ||= filename(TYPES[job.contentType], job.storageTime)
  job.status = 'saving'; setPhase(job, 'saving_original')
  const storagePath = await saveOutput(job, job.originalFilename, job.source, job.contentType, sourceHash)
  registerMedia(() => {
    registerPending(job, job.originalFilename, sourceHash, storagePath)
    job.variants.original ||= { filename: job.originalFilename, storagePath, backend: job.backend, size: job.received, hash: sourceHash, available: true }
    job.originalSavedAt ||= Date.now()
    persistJob(job)
  })
}
async function processJob(job, prepareOnly = false) {
  job.attemptStartedAt = Date.now(); job.startedAt ||= job.attemptStartedAt; job.finishedAt = null
  job.error = ''; job.retryable = false; job.encodingSpeed = null; job.estimatedRemainingMs = null
  nextGeneration(job)
  const phase = (value) => setPhase(job, value)
  const run = async (args, segment) => {
    let buffer = ''
    await command(FFMPEG, args, { signal: job.controller.signal, timeout: segment ? 0 : 30 * 60 * 1000, idleTimeout: segment ? 10 * 60 * 1000 : 0,
      onOutput(chunk) {
        buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) {
            const seconds = Math.max(0, Number(line.slice(12)) / 1e6)
            job.processedSeconds = (segment?.offset || 0) + Math.min(segment?.duration || job.duration, seconds)
            job.progress = Math.min(99, job.processedSeconds / job.duration * 100)
          }
          if (line.startsWith('speed=')) {
            const speed = Number(line.slice(6).trim().replace(/x$/, ''))
            if (speed > 0) job.encodingSpeed = job.encodingSpeed ? job.encodingSpeed * .7 + speed * .3 : speed
          }
          if (job.encodingSpeed > 0) job.estimatedRemainingMs = Math.max(0, (job.duration - job.processedSeconds) / job.encodingSpeed * 1000)
          if (line.startsWith('progress=') && Date.now() - (job.lastPersistAt || 0) > 1000) { job.lastPersistAt = Date.now(); persistJob(job) }
        }
      } })
  }
  try {
    assertActive(job)
    let sourceHash = job.sourceHash
    let info
    if (!originalReady(job)) {
      phase('verifying_source')
      await verifySource(job)
      sourceHash = await hashFile(job.source, { signal: job.controller.signal })
      if (job.sourceHash && job.sourceHash !== sourceHash) throw new Error('原件内容已改变，无法恢复')
      job.sourceHash = sourceHash
      await ensureOriginal(job, sourceHash)
      phase('probing')
      info = await probe(job.source, job.controller.signal)
      job.duration = info.duration; job.profile ||= videoProfile(info); job.encoder ||= (await tools).encoder
      const original = job.variants.original
      Object.assign(original, metrics(info, job.received), { lossy: false })
      const mp4 = /^(?:iso[0-9a-z]|mp4[12]|M4V |avc1|MSNV)/.test(info.format.tags?.major_brand || '')
      original.playbackCompatible = mp4 && ['h264', 'hevc'].includes(info.video.codec_name)
        && (info.video.codec_name !== 'hevc' || info.video.codec_tag_string === 'hvc1')
        && ['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(info.video.pix_fmt) && !original.hdr
        && (info.video.codec_name !== 'h264' || original.bitDepth === 8) && info.rate <= MAX_FRAME_RATE && info.rotation === 0
        && info.audio.length <= 1 && info.audio.every((stream) => stream.codec_name === 'aac' && stream.channels <= 2)
        && await faststart(job.source)
      original.compatibilityNote = original.playbackCompatible ? '容器与音视频格式符合本站播放规则；HEVC 仍取决于设备解码支持' : '原件不符合本站目标播放规则，保留时需自行确认设备支持'
      if (job.needsPoster) {
        phase('poster')
        const poster = await artifact(job, 'poster.jpg', signature({ source: sourceHash }),
          (file) => run([...baseOptions, ...inputOptions, '-ss', String(Math.min(.1, info.duration / 10)), '-i', job.source, '-map', `0:${info.video.index}`, '-frames:v', '1',
            '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-threads', String(job.encoder.threads), file]), async (file) => ({ size: (await stat(file)).size }))
        job.poster ||= filename('.jpg', job.storageTime)
        job.posterStoragePath = await saveOutput(job, job.poster, poster.path, 'image/jpeg', poster.hash)
        registerMedia(() => { registerPending(job, job.poster, poster.hash, job.posterStoragePath); persistJob(job) })
      }
      assertActive(job)
      job.originalReady = true
      applySelection(job, 'original')
      job.message = job.settings.enabled ? '原件已保存，可以发布；压缩在后台继续' : '原件已保存，可以发布'
      job.status = 'queued'; phase('compression_queued')
    }
    if (prepareOnly) return
    info ||= await probe(job.source, job.controller.signal)
    let output = null
    if (job.settings.enabled) {
      job.status = 'compressing'; phase('planning')
      hdrType(info)
      if (compatible(info, job.received, job.profile.budgetBytes)) {
        if (directContainer(info) && await faststart(job.source)) job.passthrough = 'source'
        else { phase('remuxing'); output = await remuxVideo(job, info, run); job.passthrough = 'remux' }
      } else { output = await encodeVideo(job, info, phase, run); job.passthrough = '' }
    } else job.passthrough = 'disabled'
    if (output) {
      job.compressedFilename ||= filename('.mp4', job.storageTime)
      job.status = 'saving'; phase('saving_compressed')
      const storagePath = await saveOutput(job, job.compressedFilename, output.path, 'video/mp4', output.hash)
      registerMedia(() => {
        registerPending(job, job.compressedFilename, output.hash, storagePath)
        job.variants.compressed = { ...metrics(output.metadata, output.size), filename: job.compressedFilename, storagePath, backend: job.backend,
          hash: output.hash, available: true, lossy: job.passthrough !== 'remux', playbackCompatible: true,
          compatibilityNote: '验证为 HEVC/hvc1 MP4；仍需要设备支持 HEVC 解码' }
        persistJob(job)
      })
    }
    job.status = 'comparing'; phase('comparing')
    try { transaction(() => {
      compareVersions(job)
      promotePublishedVideo(job)
      if (job.phaseStartedAt) { job.timings[job.phase] = (job.timings[job.phase] || 0) + Date.now() - job.phaseStartedAt; job.phaseStartedAt = null }
      job.status = job.phase = 'done'; job.progress = 100; job.finishedAt = Date.now(); persistJob(job)
    }) } catch (error) { job.status = 'saving'; job.phase = 'registering'; job.finishedAt = null; error.retryable = true; throw error }
    await cleanTemp(job)
    if (videoReferenced(job)) await cleanStored(job)
  } catch (error) {
    if (job.phaseStartedAt) { job.timings[job.phase] = (job.timings[job.phase] || 0) + Date.now() - job.phaseStartedAt; job.phaseStartedAt = null }
    if (job.status === 'done') console.warn(`视频已完成，暂存清理待下次启动：${error.message}`)
    else if (stopping && job.controller.signal.aborted) { job.status = 'queued'; job.phase = 'queued'; job.error = ''; job.retryable = false }
    else if (job.controller.signal.aborted) { job.status = job.phase = 'cancelled'; job.error = '' }
    else if (!draftActive(job) && !videoReferenced(job)) {
      job.status = job.phase = 'cancelled'; job.error = ''; job.retryable = false
      await cleanStored(job); await cleanTemp(job)
      db.prepare('DELETE FROM video_artifacts WHERE job_id = ?').run(job.id)
    } else if (error.retryable || ['ENOSPC', 'EIO', 'EBUSY', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) {
      job.phase = 'waiting'; job.error = error.message; job.retryable = true; job.estimatedRemainingMs = null
    } else {
      job.status = job.phase = 'failed'; job.error = error.message; job.finishedAt = Date.now()
      if (originalReady(job)) { job.fallbackAvailable = true; compareVersions(job); job.message = `压缩未完成，原件已保存：${error.message}` }
      console.warn(`视频任务 ${job.id} 失败：${error.message}`)
    }
  } finally {
    job.processingMs += Date.now() - job.attemptStartedAt; job.attemptStartedAt = null
    if (job.phaseStartedAt) { job.timings[job.phase] = (job.timings[job.phase] || 0) + Date.now() - job.phaseStartedAt; job.phaseStartedAt = null }
    for (const name of [job.originalFilename, job.compressedFilename, job.poster]) releaseMediaName(name)
    job.expiresAt = Date.now() + RETENTION_MS; persistJob(job)
  }
}
function scheduleJobs() {
  void drainPreparation().catch((error) => console.warn(`原件准备失败：${error.message}`))
  void drain().catch((error) => console.warn(`视频队列执行失败：${error.message}`))
}
async function drainPreparation() {
  if (preparing || stopping || isMaintenance()) return
  const release = enterOperation('media'); preparing = true
  try {
    for (;;) {
      if (stopping) break
      const job = [...jobs.values()].find((item) => item.status === 'queued' && !originalReady(item) && item.phase !== 'waiting' && !item.runPromise)
      if (!job) break
      job.runPromise = processJob(job, true)
      try { await job.runPromise } finally { job.runPromise = null }
      void drain().catch((error) => console.warn(`视频队列执行失败：${error.message}`))
    }
  } finally { preparing = false; release() }
}
async function drain() {
  if (running || stopping || isMaintenance()) return
  const release = enterOperation('media'); running = true
  try {
    for (;;) {
      if (stopping) break
      const job = [...jobs.values()].find((item) => item.status === 'queued' && originalReady(item) && item.phase !== 'waiting' && !item.runPromise)
      if (!job) break
      job.runPromise = processJob(job)
      try { await job.runPromise } finally { job.runPromise = null }
    }
  } finally { running = false; release() }
}
function complete(job) {
  assertActive(job)
  if (job.status !== 'receiving') return
  if (job.busy || job.received <= 0 || (job.total !== null && job.received !== job.total)) throw fail('视频尚未完整接收', 409)
  job.total = job.received; job.status = job.phase = 'queued'; job.queuedAt = Date.now()
  job.timings.uploading = job.queuedAt - job.createdAt; persistJob(job)
  scheduleJobs()
}
export const videoJobsApp = new Hono()
videoJobsApp.use('*', requireAuth)
videoJobsApp.use('*', async (_c, next) => { await tools; if (stopping) throw fail('服务正在停止，请稍后续传', 503); await next() })
videoJobsApp.onError((error, c) => c.json({ error: error.name === 'AbortError' ? '视频上传已停止' : error.message }, error.status || 500))
videoJobsApp.get('/config', async (c) => c.json({ ...settings(), ...(await tools), profiles: VIDEO_PROFILES, maxBytes: MAX_BYTES, chunkBytes: CHUNK_BYTES,
  codec: 'hevc', maxFps: MAX_FRAME_RATE, resolution: 'original', livePhotoCompression: true, retentionMs: RETENTION_MS }))
videoJobsApp.put('/config', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).some((key) => key !== 'enabled')) throw fail('视频采用固定档位，仅允许修改自动压缩开关')
  setSetting('video_compress_enabled', String(body.enabled)); return c.json({ ok: true, ...settings() })
})
videoJobsApp.post('/init', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || !Number.isSafeInteger(body.size)) throw fail('视频大小无效')
  return c.json(view(await createJob(c.get('user').id, { ...body, contentType: String(body.contentType || ''), needsPoster: body.needsPoster !== false })), 201)
})
videoJobsApp.post('/', async (c) => {
  const length = c.req.header('content-length')
  const job = await createJob(c.get('user').id, { draftId: c.req.query('draftId'), contentType: String(c.req.header('content-type') || '').split(';')[0].trim().toLowerCase(), size: length ? Number(length) : null })
  try { await receive(job, c.req.raw, 0, MAX_BYTES); complete(job); return c.json({ ...view(job), status: 'saving', size: job.received }, 202) }
  catch (error) { await cancel(job); throw error }
})
videoJobsApp.use('/:id/*', async (c, next) => {
  const job = findJob(c.req.param('id'), c.get('user').id)
  if (!job) throw fail('上传任务不存在或已过期', 404)
  c.set('videoJob', job); await next()
})
videoJobsApp.get('/:id', (c) => {
  const job = findJob(c.req.param('id'), c.get('user').id)
  if (!job) throw fail('上传任务不存在或已过期', 404)
  return c.json(view(job))
})
videoJobsApp.post('/:id/chunk', async (c) => {
  if (!/^\d+$/.test(c.req.query('offset') || '')) throw fail('分片偏移无效')
  const job = c.get('videoJob'); await receive(job, c.req.raw, Number(c.req.query('offset'))); return c.json(view(job))
})
videoJobsApp.post('/:id/complete', (c) => { const job = c.get('videoJob'); complete(job); return c.json(view(job), 202) })
videoJobsApp.post('/:id/select', async (c) => {
  const job = c.get('videoJob'), body = await c.req.json().catch(() => null)
  if (!body || !['original', 'compressed'].includes(body.variant)) throw fail('请选择原文件或压缩版本')
  assertActive(job)
  const ready = () => originalReady(job) && (body.variant === 'original' || selectionReady(job))
  if (!ready()) throw fail('所选视频版本尚未就绪', 409)
  if (selectionReady(job)) await job.runPromise
  assertActive(job)
  if (!ready()) throw fail('任务状态已改变，请刷新后重试', 409)
  if (referenced(job.filename) || Object.values(job.variants || {}).some((variant) => referenced(variant.filename))) throw fail('视频已发布，不能修改版本', 409)
  const selected = job.variants?.[body.variant]
  if (!selected || selected.available === false || !selected.codec) throw fail('所选版本不可用或未经视频探测验证', 409)
  const pending = db.prepare('SELECT * FROM pending_uploads WHERE filename = ? AND user_id = ?').get(selected.filename, job.userId)
  if (!pending || (pending.draft_id || null) !== job.draftId || pending.hash !== selected.hash) throw fail('此版本不再属于当前草稿', 409)
  const previous = { ...job }
  try { transaction(() => {
    applySelection(job, body.variant)
    job.selectionSource = 'user'; job.selectionUpdatedAt = Date.now()
    if (!ACTIVE.has(job.status)) { job.retryable = false; job.status = job.phase = 'done'; job.finishedAt ||= Date.now(); job.progress = 100 }
    job.message = `已采用${body.variant === 'original' ? '原文件' : '压缩版本'}${job.error ? '；处理失败原因仍保留' : ''}`
    persistJob(job)
  }) } catch (error) {
    for (const key of ['filename', 'selectedVariant', 'storagePath', 'size', 'codec', 'duration', 'selectionSource', 'selectionUpdatedAt', 'retryable', 'status', 'phase', 'finishedAt', 'progress', 'message']) job[key] = previous[key]
    throw error
  }
  if (!ACTIVE.has(job.status)) await cleanTemp(job)
  return c.json(view(job))
})
videoJobsApp.post('/:id/resume', async (c) => {
  const job = c.get('videoJob')
  if (job.status === 'receiving') {
    const body = await c.req.json(), identity = validateIdentity(body)
    if (!identity || body.size !== job.total || (job.identity && identity.fingerprint !== job.identity.fingerprint)) throw fail('请选择原始视频，文件身份不匹配', 409)
    for (const chunk of db.prepare('SELECT * FROM video_chunks WHERE job_id = ?').all(job.id)) {
      if (chunk.offset % CHUNK_BYTES !== 0 || chunk.hash !== identity.hashes[chunk.offset / CHUNK_BYTES]) throw fail('旧任务分片无法匹配新清单，请取消后重新上传', 409)
    }
    job.identity = identity; job.expiresAt = Date.now() + RETENTION_MS; persistJob(job)
  } else if (job.retryable) {
    assertActive(job); job.retryable = false; job.error = ''; job.status = job.phase = 'queued'; persistJob(job); scheduleJobs()
  }
  return c.json(view(job))
})
videoJobsApp.delete('/:id', async (c) => {
  const job = findJob(c.req.param('id'), c.get('user').id)
  if (!job) throw fail('上传任务不存在或已过期', 404)
  await cancel(job); return c.json({ ok: true })
})
export function videoJobsBusy() { return running || preparing || [...jobs.values()].some((job) => ACTIVE.has(job.status) || job.busy) }
export async function stopVideoJobs() {
  stopping = true; clearInterval(cleanupTimer); await tools
  for (const job of jobs.values()) if (ACTIVE.has(job.status)) job.controller.abort(new DOMException('服务停止，保留检查点', 'AbortError'))
  await Promise.allSettled([...jobs.values()].flatMap((job) => [job.runPromise, job.cleanupPromise, job.receivingPromise]).filter(Boolean))
  for (const job of jobs.values()) if (ACTIVE.has(job.status)) persistJob(job)
  jobs.clear(); running = preparing = false; tools = null; cleanupTimer = null
}
export async function resetVideoJobsAfterRestore() {
  if (videoJobsBusy()) throw fail('仍有视频任务未结束，无法清空恢复前状态', 409)
  for (const job of jobs.values()) await cleanTemp(job)
  for (const entry of await readdir(TMP_DIR, { withFileTypes: true })) {
    if (/^vjob-[a-f0-9-]{36}(?:\.(?:source|output\.mp4|poster\.jpg))?$/.test(entry.name)) await rm(path.join(TMP_DIR, entry.name), { recursive: true, force: true })
  }
  jobs.clear(); running = preparing = false
}
