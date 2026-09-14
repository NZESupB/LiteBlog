// AI 配图任务:持久化状态,后台执行,结果写入 WebDAV 的 ai-generated 子目录。
// 共享凭据保存在 settings，个人凭据与模式保存在 user_settings；配置文件只提供共享默认值。
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { db, getSetting, setSetting, getUserSetting, setUserSetting } from './db.js'
import { requireAuth } from './auth.js'
import { WEBDAV, deleteImage, getImage, putImage } from './storage.js'
import * as webdav from './webdav.js'
import { configValue } from './config.js'

export const imageJobsApp = new Hono()

const DEFAULT_BASE_URL = ''
const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
const AI_FOLDER = 'ai-generated'
const MAX_GENERATED_BYTES = 20 * 1024 * 1024
const JOB_TIMEOUT_MS = 10 * 60 * 1000
const controllers = new Map()

function imageMode(userId) {
  return getUserSetting(userId, 'image_mode', 'shared') === 'custom' ? 'custom' : 'shared'
}

function sharedImageConfig() {
  return {
    baseUrl: getSetting('image_base_url', String(configValue('ai.image.baseUrl', DEFAULT_BASE_URL))),
    apiKey: getSetting('image_api_key', String(configValue('ai.image.apiKey', ''))),
    model: getSetting('image_model', String(configValue('ai.image.model', DEFAULT_IMAGE_MODEL))),
  }
}

// 共享来源的模型是各人自己的选择,站点级设置只作默认值;独立来源整体按用户保存。
function imageRuntimeConfig(userId, mode = imageMode(userId)) {
  if (mode === 'custom') {
    return {
      baseUrl: getUserSetting(userId, 'image_base_url', ''),
      apiKey: getUserSetting(userId, 'image_api_key', ''),
      model: getUserSetting(userId, 'image_model', ''),
    }
  }
  const shared = sharedImageConfig()
  return { ...shared, model: getUserSetting(userId, 'image_shared_model', shared.model) }
}

// 留空只沿用所选来源的值，独立模式绝不借用共享 Key。
function draftImageConfig(userId, body) {
  const mode = body.mode === 'custom' ? 'custom' : 'shared'
  const saved = imageRuntimeConfig(userId, mode)
  const sharedBaseUrl = String(body.sharedBaseUrl ?? body.baseUrl ?? '').trim()
  const customBaseUrl = String(body.baseUrl ?? '').trim()
  return {
    mode,
    baseUrl: ((mode === 'custom' ? customBaseUrl : sharedBaseUrl) || saved.baseUrl).replace(/\/+$/, ''),
    apiKey: String((mode === 'custom' ? body.apiKey : body.sharedApiKey ?? body.apiKey) ?? '').trim() || saved.apiKey,
    model: String(body.model ?? '').trim() || saved.model,
  }
}

function imageConfigError(cfg) {
  if (!cfg.apiKey) return '尚未配置当前模式的 AI 配图 API Key，请到设置 → AI 设置 → AI 配图中填写'
  if (!requireHttpUrl(cfg.baseUrl)) return '尚未配置合法的图片接口地址，请到设置 → AI 设置 → AI 配图中填写'
  return ''
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

function imageReferenced(filename) {
  return Boolean(db.prepare(
    'SELECT 1 FROM images WHERE filename = ? OR motion_filename = ? OR poster_filename = ? LIMIT 1',
  ).get(filename, filename, filename))
}

// 草稿结束(发布或丢弃)后,清掉用户没有采用的待引用文件。
// 已挂到动态上的文件会被 images 引用,不会被误删。
export async function cleanupDraftUploads(userId, draftId) {
  if (!draftId) return 0
  const pending = db.prepare('SELECT filename, storage, storage_path FROM pending_uploads WHERE user_id = ? AND draft_id = ?').all(userId, draftId)
  const jobs = db.prepare('SELECT id, status, filename, storage, storage_path FROM image_jobs WHERE user_id = ? AND draft_id = ?').all(userId, draftId)
  const unusedJobs = jobs.filter((job) => !job.filename || !imageReferenced(job.filename))
  for (const job of unusedJobs) {
    if (['queued', 'running', 'uploading'].includes(job.status)) controllers.get(job.id)?.abort()
  }
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM pending_uploads WHERE user_id = ? AND draft_id = ?').run(userId, draftId)
    const cancelJob = db.prepare("UPDATE image_jobs SET status = 'cancelled', error = '', updated_at = datetime('now') WHERE id = ? AND status <> 'cancelled'")
    for (const job of unusedJobs) cancelJob.run(job.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const files = new Map()
  for (const row of pending) {
    if (!imageReferenced(row.filename)) files.set(`${row.storage}:${row.storage_path || row.filename}`, row)
  }
  for (const job of unusedJobs) {
    if (!job.filename) continue
    files.set(`${job.storage}:${job.storage_path || job.filename}`, { filename: job.filename, storage: job.storage, storage_path: job.storage_path })
  }
  for (const row of files.values()) {
    if (!imageReferenced(row.filename)) await deleteImage(row.filename, row.storage, row.storage_path || row.filename).catch(() => {})
  }
  return files.size
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

// 提示词先逼模型从正文里选出一个具体场景当主体,再限制不要补画正文没有的东西;
// 否则模型会退化成画一张泛泛的「温馨氛围图」,与正文对不上。
function makePrompt(text) {
  return `请为下面这篇情侣日记画一张配图。

【先定主体】
- 通读正文,挑出其中写到的一个具体场景(谁、在哪里、正在做什么),把它作为画面中心。
- 正文没有提到的人物、宠物、地点、季节、天气和物品都不要出现,也不要自行编造背景故事。
- 正文若只提到物品或心情,就画那件物品/那种光线,不要硬塞人物。

【画面】
- 单张完整画面,近景或中景,构图自然,像随手记下的一瞬,而不是海报、封面或分镜拼图。
- 色调柔和自然,可带一点温暖的玫瑰色;光线柔和,氛围安静。
- 细腻的插画或轻写实质感,避免夸张卡通、霓虹赛博和浓重的商业广告感。

【不要出现】
- 任何文字、字母、数字、水印、Logo、签名、边框、九宫格拼图或社交媒体版式。
- 正文里的 Markdown 符号、链接、图片地址都不是画面内容。
- 与正文无关的装饰道具和摆拍元素。

日记正文:
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
  const cfg = imageRuntimeConfig(row.user_id)
  const configError = imageConfigError(cfg)
  if (configError) {
    updateJob(id, { status: 'failed', error: configError, finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19) })
    return
  }
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
    const upstream = await fetch(`${cfg.baseUrl.trim().replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model || DEFAULT_IMAGE_MODEL, prompt: makePrompt(row.prompt), n: 1, size: '1024x1024', response_format: 'url' }),
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
  const userId = c.get('user').id
  const view = (cfg) => ({ baseUrl: cfg.baseUrl, model: cfg.model, hasApiKey: Boolean(cfg.apiKey) })
  const shared = imageRuntimeConfig(userId, 'shared')
  const current = imageRuntimeConfig(userId)
  return c.json({
    ...view(current), // 兼容旧客户端的顶层字段。
    mode: imageMode(userId),
    shared: view(shared),
    sharedModel: shared.model,
    custom: view(imageRuntimeConfig(userId, 'custom')),
    webdavConnected: webdav.isConnected(),
  })
})

imageJobsApp.put('/config', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) || {}
  if (body.mode !== undefined && !['shared', 'custom'].includes(body.mode)) return c.json({ error: '请选择共享或独立配置' }, 400)
  const userId = c.get('user').id
  const cfg = draftImageConfig(userId, body)
  if (!requireHttpUrl(cfg.baseUrl)) return c.json({ error: '图片接口地址必须以 http:// 或 https:// 开头' }, 400)
  if (cfg.mode === 'shared') {
    setSetting('image_base_url', cfg.baseUrl)
    if (String(body.sharedApiKey ?? body.apiKey ?? '').trim()) setSetting('image_api_key', cfg.apiKey)
    // 站点级模型只在还没有人设置过时补默认值,各人的选择存在自己的 shared_model 里。
    if (!getSetting('image_model', '') && cfg.model) setSetting('image_model', cfg.model)
    setUserSetting(userId, 'image_shared_model', cfg.model)
  } else {
    setUserSetting(userId, 'image_base_url', cfg.baseUrl)
    setUserSetting(userId, 'image_model', cfg.model)
    if (String(body.apiKey ?? '').trim()) setUserSetting(userId, 'image_api_key', cfg.apiKey)
  }
  setUserSetting(userId, 'image_mode', cfg.mode)
  return c.json({ ok: true })
})

// 自动获取模型列表:与 AI 优化同形,凭据由服务端按所选来源解析,不要求前端回显已保存的 Key。
imageJobsApp.post('/config/models', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) || {}
  if (body.mode !== undefined && !['shared', 'custom'].includes(body.mode)) return c.json({ error: '请选择共享或独立配置' }, 400)
  const cfg = draftImageConfig(c.get('user').id, body)
  if (!requireHttpUrl(cfg.baseUrl)) return c.json({ error: '请先填写合法的图片接口地址' }, 400)
  try {
    return c.json({ models: await fetchModels(cfg) })
  } catch (e) {
    return c.json({ error: e.message }, 400)
  }
})

imageJobsApp.post('/config/test', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) || {}
  if (body.mode !== undefined && !['shared', 'custom'].includes(body.mode)) return c.json({ error: '请选择共享或独立配置' }, 400)
  const cfg = draftImageConfig(c.get('user').id, body)
  if (!requireHttpUrl(cfg.baseUrl) || !cfg.apiKey) return c.json({ error: '请先填写合法的图片接口地址和 API Key' }, 400)
  try {
    const models = await fetchModels(cfg)
    return c.json({ ok: true, models, supportsModel: Boolean(cfg.model) && models.includes(cfg.model) })
  } catch (e) {
    return c.json({ error: e.message }, 400)
  }
})

// 只读上游模型列表,图片服务没有便宜的连通性探测方式,测试连接与自动获取都走这里。
async function fetchModels(cfg) {
  const response = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null)
  if (!response) throw new Error('无法连接图片接口')
  if (!response.ok) throw new Error(`连接失败 (${response.status})`)
  const data = await response.json().catch(() => ({}))
  return Array.isArray(data.data) ? data.data.map((item) => item?.id).filter(Boolean) : []
}

imageJobsApp.post('/', requireAuth, async (c) => {
  const userId = c.get('user').id
  const body = await c.req.json().catch(() => ({}))
  const text = String(body.text ?? '').trim()
  const draftId = String(body.draftId ?? '').trim()
  if (!text) return c.json({ error: '正文为空，无法生成配图' }, 400)
  if (!draftId || !draftOwnedBy(userId, draftId)) return c.json({ error: '草稿不存在或无权操作' }, 403)
  const configError = imageConfigError(imageRuntimeConfig(userId))
  if (configError) return c.json({ error: configError }, 400)
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
  const configError = imageConfigError(imageRuntimeConfig(row.user_id))
  if (configError) return c.json({ error: configError }, 400)
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
  db.prepare("UPDATE drafts SET status = 'abandoned', updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(draftId, userId)
  await cleanupDraftUploads(userId, draftId)
  return true
}
