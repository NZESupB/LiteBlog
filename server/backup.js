// 服务内数据库快照、每日调度与上传恢复；所有文件位于 DATA_DIR。
import { Hono } from 'hono'
import { backup, DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, renameSync, mkdirSync, chmodSync } from 'node:fs'
import { writeFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { db, DATA_DIR, DB_PATH, TMP_DIR, RESTORE_MARKER, initializeDatabase, getSetting, setSetting,
  closeDatabase, openDatabase, removeDatabaseSidecars, writeRestoreMarker, clearRestoreMarker, recoverInterruptedRestore, syncFile } from './db.js'
import { requireAuth, clearSession } from './auth.js'
import { backupStorage, isConnected, config as webdavConfig, resetDirectoryCache } from './webdav.js'
import { videoJobsBusy, resetVideoJobsAfterRestore } from './video-jobs.js'
import { beginMaintenance, endMaintenance, isMaintenance, hasMediaOperations } from './maintenance.js'
import { configValue } from './config.js'

const TIME_ZONE = 'Asia/Shanghai'
const DAY_MS = 86400000
const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const maxImportBytes = Number(configValue('backup.maxImportBytes', 256 * 1024 * 1024))
if (!Number.isSafeInteger(maxImportBytes) || maxImportBytes < 1024) throw new Error('backup.maxImportBytes 必须为不小于 1024 的整数字节数')
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
let operation = null
let scheduler = null
let scheduleVersion = 0
let lastResult = null

function fail(message, status = 400) { return Object.assign(new Error(message), { status }) }
function parts(now) { return Object.fromEntries(formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value])) }
export function backupDay(now = Date.now()) {
  const p = parts(now)
  return `${p.year}-${p.month}-${p.day}`
}
function stamp(now = Date.now()) {
  const p = parts(now)
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`
}
function settings() {
  const time = getSetting('backup_time', '03:30')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('已保存的备份时间无效')
  return { enabled: getSetting('backup_enabled', 'true') === 'true', time, timeZone: TIME_ZONE }
}
function savedResult() {
  if (lastResult) return lastResult
  const value = getSetting('backup_last_result', '')
  return value ? JSON.parse(value) : null
}
export function nextBackupTime(now = Date.now()) {
  const cfg = settings()
  if (!cfg.enabled || !isConnected()) return null
  const day = backupDay(now)
  const today = Date.parse(`${day}T${cfg.time}:00+08:00`)
  const completed = getSetting('backup_success_day', '') === day || getSetting('backup_attempt_day', '') === day
  return new Date(completed ? today + DAY_MS : Math.max(now, today)).toISOString()
}
export function backupStatus() {
  const wd = webdavConfig()
  return { ...settings(), webdavReady: isConnected(), folder: wd.folder,
    state: operation?.type || 'idle', startedAt: operation?.startedAt || null,
    lastResult: savedResult(), nextRunAt: nextBackupTime(), maxImportBytes }
}
function acquire(type) {
  if (operation || isMaintenance()) throw fail('备份或恢复正在进行，请稍后重试', 409)
  operation = { type, startedAt: new Date().toISOString() }
}
async function removeTemp(filename) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await unlink(filename + suffix).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}
function recordResult(result) {
  lastResult = result
  setSetting('backup_last_result', JSON.stringify(result))
}

export function startBackup(trigger = 'manual', now = Date.now()) {
  acquire('backing-up')
  let storage
  try {
    if (trigger === 'scheduled') setSetting('backup_attempt_day', backupDay(now))
    storage = backupStorage()
  } catch (error) {
    recordResult({ ok: false, trigger, startedAt: operation.startedAt, finishedAt: new Date().toISOString(), error: error.message })
    operation = null
    throw error
  }
  const promise = performBackup(storage, trigger, now).finally(() => { operation = null })
  // HTTP 首响应不等待上传；失败通过持久化状态呈现。
  promise.catch((error) => console.warn(`数据库备份失败：${error.message}`))
  return promise
}
async function performBackup(storage, trigger, now) {
  const filename = path.join(TMP_DIR, `backup-${randomUUID()}.db`)
  const startedAt = operation.startedAt
  let uploaded = false, name = '', warning = ''
  try {
    await backup(db, filename)
    chmodSync(filename, 0o600)
    const size = (await stat(filename)).size
    const previousName = savedResult()?.filename
    let timestamp = now
    for (let attempt = 0; attempt < 10; attempt++) {
      name = `blog-backup-${stamp(timestamp)}.db`
      if (name === previousName) { timestamp += 1000; continue }
      try { await storage.upload(name, filename, size); uploaded = true; break }
      catch (error) { if (error.status !== 412) throw error; timestamp += 1000 }
    }
    if (!uploaded) throw new Error('同名备份连续冲突，请稍后重试')
    setSetting('backup_success_day', backupDay(Date.now()))
    try {
      for (const stale of await storage.list()) if (stale !== name) await storage.remove(stale)
    } catch (error) { warning = error.message }
    await removeTemp(filename)
    const result = { ok: true, trigger, filename: name, size, startedAt, finishedAt: new Date().toISOString(), warning }
    recordResult(result)
    return result
  } catch (error) {
    let cleanupError = ''
    try { await removeTemp(filename) } catch (failure) { cleanupError = `；临时快照清理失败：${failure.message}` }
    const result = { ok: uploaded, trigger, filename: uploaded ? name : null, startedAt, finishedAt: new Date().toISOString(),
      error: uploaded ? '' : error.message, warning: uploaded ? error.message + cleanupError : cleanupError }
    recordResult(result)
    if (!uploaded) throw error
    return result
  }
}

export async function runScheduledBackup(now = Date.now()) {
  if (operation || isMaintenance()) return
  const cfg = settings(), day = backupDay(now)
  if (!cfg.enabled || !isConnected() || now < Date.parse(`${day}T${cfg.time}:00+08:00`)
    || getSetting('backup_success_day', '') === day || getSetting('backup_attempt_day', '') === day) return
  await startBackup('scheduled', now)
}
export function stopBackupScheduler() { clearTimeout(scheduler); scheduler = null; scheduleVersion++ }
export function startBackupScheduler(delay = 1000) {
  stopBackupScheduler()
  const version = scheduleVersion
  // 每分钟复核，也能补执行停服期间错过的当天任务。
  scheduler = setTimeout(async () => {
    try { await runScheduledBackup() } catch (error) { console.warn(`定时备份失败：${error.message}`) }
    finally { if (!isMaintenance() && version === scheduleVersion) startBackupScheduler(60000) }
  }, delay)
  scheduler.unref()
}

function assertNoMediaJobs() {
  if (hasMediaOperations() || videoJobsBusy()
    || db.prepare("SELECT 1 FROM image_jobs WHERE status IN ('queued', 'running', 'uploading') LIMIT 1").get()
    || db.prepare("SELECT 1 FROM video_jobs WHERE status IN ('receiving', 'queued', 'compressing', 'saving') LIMIT 1").get()) {
    throw fail('仍有上传、视频处理、AI 配图或媒体清理任务，请先完成或取消后再恢复', 409)
  }
}

export function validateImport(filename) {
  let connection, reference
  try {
    connection = new DatabaseSync(filename)
    connection.exec('PRAGMA trusted_schema = OFF')
    const integrity = connection.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw fail('数据库完整性检查失败')
    if (connection.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('trigger', 'view') LIMIT 1").get()) throw fail('导入库包含本应用不支持的触发器或视图')
    const core = { users: ['id', 'name', 'pass_hash', 'created_at'], posts: ['id', 'user_id', 'content', 'created_at', 'updated_at'], images: ['id', 'post_id', 'filename', 'sort'] }
    for (const [table, columns] of Object.entries(core)) {
      const actual = connection.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
      if (columns.some((column) => !actual.includes(column))) throw fail(`不是可恢复的本站数据库：缺少 ${table} 核心字段`)
    }
    if (!connection.prepare('SELECT 1 FROM users LIMIT 1').get()) throw fail('导入库没有账号，无法恢复后登录')
    initializeDatabase(connection, { seed: false })
    reference = new DatabaseSync(':memory:')
    initializeDatabase(reference, { seed: false })
    for (const { name } of reference.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      const columns = connection.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name)
      if (reference.prepare(`PRAGMA table_info(${name})`).all().some((column) => !columns.includes(column.name))) throw fail(`导入库 ${name} 表字段不完整`)
    }
    const backupTime = connection.prepare("SELECT value FROM settings WHERE key = 'backup_time'").get()?.value
    if (backupTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(backupTime)) throw fail('导入库的定时备份时间无效')
    if (connection.prepare('PRAGMA foreign_key_check').all().length) throw fail('导入库存在无效的关联数据')
    for (const user of connection.prepare('SELECT pass_hash FROM users').all()) {
      if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(user.pass_hash || '')) throw fail('导入库账号密码格式无效')
    }
    const now = Date.now()
    for (const row of connection.prepare('SELECT id, status, snapshot FROM video_jobs').all()) {
      const state = JSON.parse(row.snapshot)
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw fail('导入库视频任务记录无效')
      if (['receiving', 'queued', 'compressing', 'saving'].includes(row.status)) {
        Object.assign(state, { status: 'failed', phase: 'failed', error: '数据库恢复中断了视频处理，请重新选择视频', finishedAt: now, estimatedRemainingMs: null })
        connection.prepare("UPDATE video_jobs SET status = 'failed', snapshot = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(state), now, row.id)
      }
    }
    connection.prepare("UPDATE image_jobs SET status = 'failed', error = '数据库恢复中断了配图，请点击重试', updated_at = datetime('now') WHERE status IN ('queued', 'running', 'uploading')").run()
    connection.prepare("INSERT INTO settings (key, value) VALUES ('session_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(randomUUID())
    // 快照中的调度结果属于旧数据库；恢复后从新状态开始，避免立即覆盖远端备份。
    connection.prepare("DELETE FROM settings WHERE key IN ('backup_last_result', 'backup_success_day', 'backup_attempt_day')").run()
    connection.prepare("INSERT INTO settings (key, value) VALUES ('backup_attempt_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(backupDay())
    connection.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;')
  } catch (error) {
    if (error.status) throw error
    throw fail(`导入数据库不可用：${error.message}`)
  } finally {
    try { reference?.close() } finally { connection?.close() }
  }
  removeDatabaseSidecars(filename)
  syncFile(filename)
}

async function importForm(c) {
  const request = c.req.raw
  const limit = maxImportBytes + 64 * 1024
  if (Number(request.headers.get('content-length')) > limit) throw fail('导入请求超过大小上限', 413)
  if (!request.body || !/^multipart\/form-data\s*;/i.test(request.headers.get('content-type') || '')) throw fail('请上传 db 文件')
  let size = 0, overflow = false
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)])
  const bounded = request.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    size += chunk.byteLength
    if (size > limit) { overflow = true; throw fail('导入请求超过大小上限', 413) }
    controller.enqueue(chunk)
  } }), { signal })
  let form
  try { form = await new Request(request.url, { method: 'POST', headers: request.headers, body: bounded, duplex: 'half' }).formData() }
  catch { throw fail(overflow ? '导入请求超过大小上限' : signal.aborted ? '上传已取消或超过两分钟，请重新选择文件' : '无法读取上传文件', overflow ? 413 : signal.aborted ? 408 : 400) }
  if (form.get('confirm') !== 'true') throw fail('请确认整体替换当前数据库')
  const file = form.get('file')
  if (form.getAll('file').length !== 1 || !(file instanceof File) || !/\.db$/i.test(file.name) || !file.size) throw fail('请选择一个非空的 .db 文件')
  if (file.size > maxImportBytes) throw fail('db 文件超过导入大小上限', 413)
  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length < 16 || !bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw fail('文件不是有效的 SQLite 数据库')
  return bytes
}

async function restore(c) {
  acquire('restoring')
  const staged = path.join(TMP_DIR, `restore-${randomUUID()}.db`)
  let maintaining = false, fatal = false, marked = false
  const schedulerWasRunning = Boolean(scheduler)
  try {
    assertNoMediaJobs()
    const bytes = await importForm(c)
    await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
    validateImport(staged)
    assertNoMediaJobs()
    // 保留恢复请求自身的登记，维护中间件会在响应 finally 中释放它。
    const operationToken = c.get('databaseOperationToken')
    maintaining = true
    stopBackupScheduler()
    await beginMaintenance(10000, operationToken)
    assertNoMediaJobs()
    mkdirSync(BACKUP_DIR, { recursive: true })
    const safetyBackup = `before-restore-${stamp()}-${randomUUID()}.db`
    const safetyPath = path.join(BACKUP_DIR, safetyBackup)
    await backup(db, safetyPath)
    chmodSync(safetyPath, 0o600)
    syncFile(safetyPath)
    syncFile(BACKUP_DIR)
    writeRestoreMarker({ phase: 'prepared', safetyBackup })
    marked = true
    closeDatabase()
    removeDatabaseSidecars()
    renameSync(staged, DB_PATH)
    syncFile(DATA_DIR)
    openDatabase()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    syncFile(DB_PATH)
    await resetVideoJobsAfterRestore()
    resetDirectoryCache()
    writeRestoreMarker({ phase: 'committed', safetyBackup })
    marked = false
    lastResult = null
    try { clearRestoreMarker() } catch { console.warn('恢复已提交，阶段记录将在下次启动清理') }
    clearSession(c)
    return c.json({ ok: true, requiresLogin: true, safetyBackup })
  } catch (error) {
    if (marked || existsSync(RESTORE_MARKER)) {
      try {
        closeDatabase()
        recoverInterruptedRestore()
        openDatabase()
      } catch (failure) {
        fatal = true
        throw fail(`恢复失败且回退失败，服务保持维护状态：${failure.message}`, 500)
      }
    }
    throw error
  } finally {
    try { await removeTemp(staged) } catch (error) { console.warn(`清理导入暂存文件失败：${error.message}`) }
    operation = null
    if (maintaining && !fatal) {
      endMaintenance()
      if (schedulerWasRunning) startBackupScheduler()
    }
  }
}

export const backupsApp = new Hono()
backupsApp.use('*', requireAuth)
backupsApp.use('*', async (c, next) => {
  if (c.req.method !== 'GET') {
    const origin = c.req.header('origin'), referer = c.req.header('referer')
    const host = c.req.header('host') || new URL(c.req.url).host
    const source = origin || referer
    if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: '请从本站设置页操作' }, 403)
    if (source) {
      let url
      try { url = new URL(source) } catch { return c.json({ error: '操作来源无效' }, 403) }
      if (!['http:', 'https:'].includes(url.protocol) || url.host !== host) return c.json({ error: '请从本站设置页操作' }, 403)
    } else if (c.req.header('sec-fetch-site') && c.req.header('sec-fetch-site') !== 'same-origin') return c.json({ error: '请从本站设置页操作' }, 403)
  }
  c.header('Cache-Control', 'no-store')
  await next()
})
backupsApp.onError((error, c) => c.json({ error: error.message || '备份与恢复操作失败' }, error.status || 500))
backupsApp.get('/', (c) => c.json(backupStatus()))
backupsApp.put('/config', async (c) => {
  if (operation) throw fail('备份或恢复正在进行，请稍后保存', 409)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time || '')) throw fail('请提供自动备份开关与 HH:mm 格式的时间')
  setSetting('backup_enabled', String(body.enabled))
  setSetting('backup_time', body.time)
  if (scheduler) startBackupScheduler()
  return c.json(backupStatus())
})
backupsApp.post('/', (c) => { startBackup(); return c.json(backupStatus(), 202) })
backupsApp.post('/restore', restore)
