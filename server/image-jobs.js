// AI 配图任务:持久化状态,后台执行,结果写入 WebDAV 的 ai-generated 子目录。
// 上游地址和 Key 保存在服务端 settings；config.json 或 Docker Compose environment 只提供默认值。
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { db, getSetting, setSetting } from './db.js'
import { requireAuth } from './auth.js'
import { WEBDAV, deleteImage, getImage, putImage } from './storage.js'
import * as webdav from './webdav.js'
import { configValue } from './config.js'

export const imageJobsApp = new Hono()

const DEFAULT_BASE_URL = ''
const IMAGE_MODEL = 'gpt-image-2'
const AI_FOLDER = 'ai-generated'
const MAX_GENERATED_BYTES = 20 * 1024 * 1024
const JOB_TIMEOUT_MS = 10 * 60 * 1000
const controllers = new Map()

function imageRuntimeConfig() {
  return {
    baseUrl: getSetting('image_base_url', String(configValue('ai.image.baseUrl', DEFAULT_BASE_URL))),
    apiKey: getSetting('image_api_key', String(configValue('ai.image.apiKey', ''))),
  }
}

function imageApiKey() {
  return imageRuntimeConfig().apiKey
}

function imageBaseUrl() {
  return String(imageRuntimeConfig().baseUrl || '').trim().replace(/\/+$/, '')
}

function requireHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value || '').trim())
}

function draftForUser(userId, draftId) {
  if (!draftId) return null
  return db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(String(draftId), userId)
}

export function ensureDraft(userId, draftId, postId = null) {
  const id = String(draftId || randomUUID())
  const existing = draftForUser(userId, id)
  if (existing) {
    if (existing.status !== 'published' && postId && existing.post_id !== Number(postId)) {
      db.prepare("UPDATE drafts SET post_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(Number(postId), id, userId)
    }
    if (existing.status !== 'active' && existing.status !== 'published') {
      db.prepare("UPDATE drafts SET status = 'active', updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(id, userId)
    }
    return id
  }
  db.prepare('INSERT INTO drafts (id, user_id, post_id) VALUES (?, ?, ?)').run(id, userId, postId ? Number(postId) : null)
  return id
}

export function draftOwnedBy(userId, draftId) {
  return Boolean(draftForUser(userId, draftId))
}

function updateJob(id, fields) {
  const allowed = ['status', 'filename', 'storage', 'storage_path', 'mime', 'hash', 'error', 'finished_at']
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined)
  if (!entries.length) return
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ')
  db.prepare(`UPDATE image_jobs SET ${assignments}, updated_at = datetime('now') WHERE id = ?`).run(...entries.map(([, value]) => value), id)
}

function taskView(row) {
  return {
    id: row.id,
    draftId: row.draft_id,
    status: row.status,
    filename: row.filename,
    storage: row.storage,
    storagePath: row.storage_path,
    mime: row.mime,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    previewUrl: row.status === 'succeeded' ? `/api/image-jobs/${row.id}/preview` : null,
  }
}

function promptHash(text) {
  return createHash('sha256').update(text).digest('hex')
}

function makePrompt(text) {
  return `请根据下面这篇情侣日记生成一张温柔、自然、有生活气息的氛围配图。
要求：画面表达正文中的场景和真实情绪；柔和的玫瑰粉与自然色调；细腻的插画或轻写实绘画质感；不要出现任何文字、字母、数字、水印、Logo、边框或社交媒体版式；不要虚构明显违背正文的事实；输出适合作为私人日记配图的单张画面。

日记正文：
${text}`
}

function stampedName(hash, ext) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `ai-${stamp}-${hash.slice(0, 10)}-${randomUUID().slice(0, 8)}${ext}`
}

function responseImage(data) {
  const first = Array.isArray(data?.data) ? data.data[0] : null
  const rawB64 = String(first?.b64_json || '').trim()
  if (rawB64) {
    const match = rawB64.match(/^data:(image\/[^;]+);base64,(.*)$/s)
    return { buffer: Buffer.from(match ? match[2] : rawB64, 'base64'), mime: match?.[1] || 'image/png' }
  }
  const url = String(first?.url || '').trim()
  if (!url || !requireHttpUrl(url)) throw new Error('图片服务没有返回可用图片')
  return { url }
}

async function downloadImage(url, signal) {
  const response = await fetch(url, { signal, redirect: 'error' })
  if (!response.ok) throw new Error(`下载生成图片失败 (${response.status})`)
  const type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase()
  if (!type.startsWith('image/')) throw new Error('图片服务返回的内容不是图片')
  const length = Number(response.headers.get('content-length') || 0)
  if (length > MAX_GENERATED_BYTES) throw new Error('生成图片超过 20MB 限制')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length || buffer.length > MAX_GENERATED_BYTES) throw new Error('生成图片大小不合法')
  return { buffer, mime: type }
}

function extForMime(mime) {
  return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'
}

async function runJob(id) {
  const row = db.prepare('SELECT * FROM image_jobs WHERE id = ?').get(id)
  if (!row || row.status === 'cancelled') return
  if (!webdav.isConnected()) {
    updateJob(id, { status: 'failed', error: 'AI 配图需要先配置可用的 WebDAV 存储', finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19) })
    return
  }

  const controller = new AbortController()
  controllers.set(id, controller)
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('AI 配图超过 10 分钟仍未完成'))
  }, JOB_TIMEOUT_MS)
  try {
    updateJob(id, { status: 'running', error: '' })
    const upstream = await fetch(`${imageBaseUrl()}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${imageApiKey()}` },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt: makePrompt(row.prompt), n: 1, size: '1024x1024', response_format: 'url' }),
      signal: controller.signal,
    })
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 240)
      throw new Error(`图片服务请求失败 (${upstream.status})${detail ? `: ${detail}` : ''}`)
    }
    const payload = await upstream.json().catch(() => null)
    const result = responseImage(payload)
    const image = result.buffer ? result : await downloadImage(result.url, controller.signal)
    if (!image.buffer?.length || image.buffer.length > MAX_GENERATED_BYTES) throw new Error('生成图片大小不合法')
    if (controller.signal.aborted) throw new Error('任务已取消')
    updateJob(id, { status: 'uploading', mime: image.mime })
    const hash = createHash('sha256').update(image.buffer).digest('hex').slice(0, 16)
    const ext = extForMime(image.mime)
    const filename = stampedName(hash, ext)
    const storagePath = `${AI_FOLDER}/${filename}`
    await putImage(filename, image.buffer, image.mime, storagePath, WEBDAV)
    if (controller.signal.aborted) {
      await deleteImage(filename, WEBDAV, storagePath)
      throw new Error('任务已取消')
    }
    const current = db.prepare('SELECT * FROM image_jobs WHERE id = ?').get(id)
    if (!current || current.status === 'cancelled') {
      await deleteImage(filename, WEBDAV, storagePath)
      return
    }
    db.prepare(`INSERT INTO pending_uploads (filename, hash, storage, user_id, draft_id, storage_path)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(filename) DO UPDATE SET hash = excluded.hash, storage = excluded.storage,
      user_id = excluded.user_id, draft_id = excluded.draft_id, storage_path = excluded.storage_path,
      created_at = datetime('now')`).run(filename, hash, WEBDAV, row.user_id, row.draft_id, storagePath)
    updateJob(id, { status: 'succeeded', filename, storage: WEBDAV, storage_path: storagePath, mime: image.mime, hash, error: '', finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19) })
  } catch (error) {
    const current = db.prepare('SELECT status FROM image_jobs WHERE id = ?').get(id)
    const cancelled = current?.status === 'cancelled' || (!timedOut && controller.signal.aborted)
    if (!cancelled) updateJob(id, { status: 'failed', error: error?.message || 'AI 配图失败', finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19) })
  } finally {
    clearTimeout(timeout)
    controllers.delete(id)
  }
}

function startJob(row) {
  queueMicrotask(() => runJob(row.id).catch((error) => updateJob(row.id, { status: 'failed', error: error.message || 'AI 配图失败' })))
}

// 进程重启时不能假装这些任务仍在执行,让用户明确重试。
db.prepare("UPDATE image_jobs SET status = 'failed', error = '服务重启时任务中断，请点击重试', updated_at = datetime('now') WHERE status IN ('queued', 'running', 'uploading')").run()

imageJobsApp.get('/', requireAuth, (c) => {
  const rows = db.prepare('SELECT * FROM image_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(c.get('user').id)
  return c.json({ jobs: rows.map(taskView) })
})

imageJobsApp.get('/config', requireAuth, (c) => {
  const cfg = imageRuntimeConfig()
  return c.json({ baseUrl: cfg.baseUrl, hasApiKey: Boolean(cfg.apiKey), model: IMAGE_MODEL, webdavConnected: webdav.isConnected() })
})

imageJobsApp.put('/config', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const baseUrl = String(body.baseUrl ?? '').trim() || imageRuntimeConfig().baseUrl
  const apiKey = String(body.apiKey ?? '').trim()
  if (!requireHttpUrl(baseUrl)) return c.json({ error: '图片接口地址必须以 http:// 或 https:// 开头' }, 400)
  setSetting('image_base_url', baseUrl.replace(/\/+$/, ''))
  if (apiKey) setSetting('image_api_key', apiKey)
  return c.json({ ok: true })
})

imageJobsApp.post('/config/test', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const saved = imageRuntimeConfig()
  const baseUrl = (String(body.baseUrl ?? '').trim() || saved.baseUrl).replace(/\/+$/, '')
  const apiKey = String(body.apiKey ?? '').trim() || saved.apiKey
  if (!requireHttpUrl(baseUrl) || !apiKey) return c.json({ error: '请先填写合法的图片接口地址和 API Key' }, 400)
  const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) }).catch(() => null)
  if (!response) return c.json({ error: '无法连接图片接口' }, 502)
  if (!response.ok) return c.json({ error: `连接失败 (${response.status})` }, 400)
  const data = await response.json().catch(() => ({}))
  const models = Array.isArray(data.data) ? data.data.map((item) => item?.id).filter(Boolean) : []
  return c.json({ ok: true, models, supportsGptImage2: models.includes(IMAGE_MODEL) })
})

imageJobsApp.post('/', requireAuth, async (c) => {
  const userId = c.get('user').id
  const body = await c.req.json().catch(() => ({}))
  const text = String(body.text ?? '').trim()
  const draftId = String(body.draftId ?? '').trim()
  if (!text) return c.json({ error: '正文为空，无法生成配图' }, 400)
  if (!draftId || !draftOwnedBy(userId, draftId)) return c.json({ error: '草稿不存在或无权操作' }, 403)
  if (!imageApiKey()) return c.json({ error: '尚未配置 AI 绘图 API Key，请到设置 → AI 优化 → AI 配图中填写' }, 400)
  if (!requireHttpUrl(imageBaseUrl())) return c.json({ error: '尚未配置合法的图片接口地址，请到设置 → AI 优化 → AI 配图中填写' }, 400)
  const hash = promptHash(text)
  const duplicate = db.prepare(`SELECT * FROM image_jobs WHERE user_id = ? AND draft_id = ? AND prompt_hash = ?
    AND status IN ('queued', 'running', 'uploading', 'succeeded') ORDER BY created_at DESC LIMIT 1`).get(userId, draftId, hash)
  if (duplicate) return c.json({ task: taskView(duplicate), reused: true }, 202)
  const active = db.prepare("SELECT id FROM image_jobs WHERE user_id = ? AND status IN ('queued', 'running', 'uploading') LIMIT 1").get(userId)
  if (active) return c.json({ error: '已有一项 AI 配图正在生成，请等待完成或取消' }, 409)
  const id = randomUUID()
  db.prepare('INSERT INTO image_jobs (id, user_id, draft_id, prompt_hash, prompt) VALUES (?, ?, ?, ?, ?)').run(id, userId, draftId, hash, text)
  const row = db.prepare('SELECT * FROM image_jobs WHERE id = ?').get(id)
  startJob(row)
  return c.json({ task: taskView(row) }, 202)
})

imageJobsApp.get('/:id', requireAuth, (c) => {
  const row = db.prepare('SELECT * FROM image_jobs WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id)
  if (!row) return c.json({ error: '任务不存在' }, 404)
  return c.json({ task: taskView(row) })
})

imageJobsApp.get('/:id/preview', requireAuth, async (c) => {
  const row = db.prepare('SELECT * FROM image_jobs WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id)
  if (!row || row.status !== 'succeeded' || !row.filename) return c.text('Not Found', 404)
  try {
    const buffer = await getImage(row.filename, row.storage, row.storage_path || row.filename)
    return c.body(buffer, 200, { 'Content-Type': row.mime || 'image/png', 'Cache-Control': 'private, max-age=300' })
  } catch {
    return c.text('Bad Gateway', 502)
  }
})

imageJobsApp.post('/:id/retry', requireAuth, (c) => {
  const row = db.prepare('SELECT * FROM image_jobs WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id)
  if (!row) return c.json({ error: '任务不存在' }, 404)
  if (!['failed', 'cancelled'].includes(row.status)) return c.json({ error: '当前任务不能重试' }, 409)
  const active = db.prepare("SELECT id FROM image_jobs WHERE user_id = ? AND status IN ('queued', 'running', 'uploading') LIMIT 1").get(c.get('user').id)
  if (active) return c.json({ error: '已有一项 AI 配图正在生成' }, 409)
  db.prepare("UPDATE image_jobs SET status = 'queued', error = '', filename = NULL, storage = NULL, storage_path = NULL, mime = NULL, hash = NULL, finished_at = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id)
  const fresh = db.prepare('SELECT * FROM image_jobs WHERE id = ?').get(row.id)
  startJob(fresh)
  return c.json({ task: taskView(fresh) }, 202)
})

imageJobsApp.delete('/:id', requireAuth, async (c) => {
  const row = db.prepare('SELECT * FROM image_jobs WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id)
  if (!row) return c.json({ ok: true })
  const controller = controllers.get(row.id)
  controller?.abort()
  db.prepare("UPDATE image_jobs SET status = 'cancelled', error = '', updated_at = datetime('now') WHERE id = ? AND status <> 'cancelled'").run(row.id)
  if (row.filename) {
    db.prepare('DELETE FROM pending_uploads WHERE filename = ? AND user_id = ?').run(row.filename, row.user_id)
    const reference = db.prepare('SELECT 1 FROM images WHERE filename = ? LIMIT 1').get(row.filename)
    if (!reference) await deleteImage(row.filename, row.storage, row.storage_path || row.filename).catch(() => {})
  }
  return c.json({ ok: true })
})

export async function abandonDraft(userId, draftId) {
  const draft = draftForUser(userId, draftId)
  if (!draft) return false
  const pending = db.prepare('SELECT filename, storage, storage_path FROM pending_uploads WHERE user_id = ? AND draft_id = ?').all(userId, draftId)
  const activeJobs = db.prepare("SELECT id FROM image_jobs WHERE user_id = ? AND draft_id = ? AND status IN ('queued', 'running', 'uploading')").all(userId, draftId)
  for (const job of activeJobs) controllers.get(job.id)?.abort()
  db.prepare("UPDATE drafts SET status = 'abandoned', updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(draftId, userId)
  db.prepare("UPDATE image_jobs SET status = 'cancelled', updated_at = datetime('now') WHERE user_id = ? AND draft_id = ? AND status <> 'cancelled'").run(userId, draftId)
  db.prepare('DELETE FROM pending_uploads WHERE user_id = ? AND draft_id = ?').run(userId, draftId)
  for (const row of pending) {
    const reference = db.prepare('SELECT 1 FROM images WHERE filename = ? LIMIT 1').get(row.filename)
    if (!reference) await deleteImage(row.filename, row.storage, row.storage_path || row.filename).catch(() => {})
  }
  return true
}
