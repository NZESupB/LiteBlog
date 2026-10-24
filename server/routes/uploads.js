import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { db } from '../db.js'
import { requireAuth } from '../auth.js'
import { ensureDraft, draftOwnedBy, abandonDraft } from '../image-jobs.js'
import { draftVideoJobs, videoJobsApp } from '../video-jobs.js'
import {
  activeBackend,
  putImage,
  getImage,
  deleteImage,
  reserveMediaName,
  releaseMediaName,
  storeNewMedia,
} from '../storage.js'
import { mediaDateParts } from '../media-path.js'
import { IMAGE_EXT, MIME_BY_EXT, UPLOAD_NAME_RE } from '../services/site.js'
import { isReferenced } from '../services/media.js'

export function registerUploads(app) {
  app.post('/api/drafts', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return c.json({ id: ensureDraft(c.get('user').id, body.id, Number(body.postId) || null) })
  })
  app.get('/api/drafts/:id', requireAuth, async (c) => {
    const userId = c.get('user').id
    const draft = db
      .prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?')
      .get(c.req.param('id'), userId)
    if (!draft) return c.json({ error: '草稿不存在' }, 404)
    const pending = db
      .prepare(
        'SELECT filename, hash, storage, draft_id, storage_path, created_at FROM pending_uploads WHERE draft_id = ? AND user_id = ? ORDER BY created_at, filename',
      )
      .all(draft.id, userId)
    const jobs = db
      .prepare(
        'SELECT id, status, filename, storage, storage_path, mime, error, created_at, updated_at, finished_at FROM image_jobs WHERE draft_id = ? AND user_id = ? ORDER BY created_at DESC',
      )
      .all(draft.id, userId)
    return c.json({ draft, pending, jobs, videoJobs: await draftVideoJobs(userId, draft.id) })
  })
  app.delete('/api/drafts/:id', requireAuth, async (c) =>
    c.json({ ok: await abandonDraft(c.get('user').id, c.req.param('id')) }),
  )
  app.get('/api/drafts/:id/preview/:name', requireAuth, async (c) => {
    const id = c.req.param('id'),
      name = c.req.param('name'),
      userId = c.get('user').id
    if (!UPLOAD_NAME_RE.test(name) || !draftOwnedBy(userId, id)) return c.text('Not Found', 404)
    const row = db
      .prepare(
        'SELECT storage, storage_path FROM pending_uploads WHERE filename = ? AND draft_id = ? AND user_id = ?',
      )
      .get(name, id, userId)
    if (!row) return c.text('Not Found', 404)
    try {
      return c.body(await getImage(name, row.storage, row.storage_path || name), 200, {
        'Content-Type': MIME_BY_EXT[path.extname(name)],
        'Cache-Control': 'private, max-age=300',
      })
    } catch {
      return c.text('Bad Gateway', 502)
    }
  })
  app.route('/api/uploads/video', videoJobsApp)
  app.post('/api/uploads', requireAuth, async (c) => {
    const startedAt = Date.now(),
      backend = activeBackend()
    await cleanupPendingUploads()
    const form = await c.req.formData(),
      file = form.get('image')
    const draftId = String(form.get('draftId') || '').trim() || null,
      userId = c.get('user').id
    if (draftId && !draftOwnedBy(userId, draftId)) return c.json({ error: '草稿不存在或无权操作' }, 403)
    if (!file || typeof file !== 'object' || !file.size) return c.json({ error: '没有收到图片' }, 400)
    const ext = IMAGE_EXT[file.type]
    if (!ext) return c.json({ error: `不支持的图片类型: ${file.type || '未知'}` }, 400)
    if (file.size > 10 * 1024 * 1024) return c.json({ error: '单张图片不能超过 10MB' }, 400)
    const buf = Buffer.from(await file.arrayBuffer()),
      hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
    const pending = db
      .prepare(
        `SELECT filename, hash, storage, storage_path, user_id, draft_id FROM pending_uploads WHERE hash = ? AND user_id = ? AND ${draftId ? 'draft_id = ?' : 'draft_id IS NULL'} LIMIT 1`,
      )
      .get(...(draftId ? [hash, userId, draftId] : [hash, userId]))
    const owned = db
      .prepare(
        'SELECT i.filename, i.hash, i.storage, i.storage_path FROM images i JOIN posts p ON p.id = i.post_id WHERE i.hash = ? AND p.user_id = ? ORDER BY i.id LIMIT 1',
      )
      .get(hash, userId)
    let exist = pending || null
    if (!exist && owned) {
      const atName = db
        .prepare('SELECT user_id, draft_id, hash FROM pending_uploads WHERE filename = ? LIMIT 1')
        .get(owned.filename)
      if (
        !atName ||
        (atName.user_id === userId && atName.hash === hash && (atName.draft_id ?? null) === draftId)
      )
        exist = owned
    }
    let filename = exist?.filename,
      storagePath = exist ? exist.storage_path || filename : null
    const storage = exist?.storage || backend
    try {
      if (!exist) {
        const unique = Boolean(
          owned ||
          db.prepare('SELECT 1 FROM images WHERE hash = ? LIMIT 1').get(hash) ||
          db.prepare('SELECT 1 FROM pending_uploads WHERE hash = ? LIMIT 1').get(hash),
        )
        filename = reserveMediaName((attempt) => stampedName(hash, ext, unique || attempt > 0, startedAt))
        storagePath = await storeNewMedia(filename, storage, startedAt, (relativePath, options) =>
          putImage(filename, buf, MIME_BY_EXT[ext], relativePath, storage, options),
        )
      }
      if (exist)
        db.prepare(
          `INSERT INTO pending_uploads (filename, hash, storage, user_id, draft_id, storage_path) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(filename) DO UPDATE SET user_id = excluded.user_id, draft_id = excluded.draft_id, storage_path = excluded.storage_path, created_at = datetime('now')`,
        ).run(filename, hash, storage, userId, draftId, storagePath)
      else
        db.prepare(
          'INSERT INTO pending_uploads (filename, hash, storage, user_id, draft_id, storage_path) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(filename, hash, storage, userId, draftId, storagePath)
      return c.json({ filename, url: `/uploads/${filename}` })
    } catch (error) {
      if (!exist && storagePath && !isReferenced(filename))
        await deleteImage(filename, storage, storagePath).catch((e) =>
          console.warn(`清理上传图片失败: ${e.message}`),
        )
      console.warn(`上传图片 ${filename || ''} 失败: ${error.message}`)
      return c.json({ error: error.message }, 502)
    } finally {
      if (!exist) releaseMediaName(filename)
    }
  })
  app.delete('/api/uploads/:name', requireAuth, async (c) => {
    const name = c.req.param('name')
    const row = db
      .prepare('SELECT storage, storage_path FROM pending_uploads WHERE filename = ? AND user_id = ?')
      .get(name, c.get('user').id)
    if (!row) return c.json({ ok: true })
    db.prepare('DELETE FROM pending_uploads WHERE filename = ?').run(name)
    if (!isReferenced(name)) await deleteImage(name, row.storage, row.storage_path || name).catch(() => {})
    return c.json({ ok: true })
  })
}
function stampedName(hash, ext, unique, time) {
  const p = mediaDateParts(time)
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${hash.slice(0, 8)}${unique ? `-${randomUUID().slice(0, 8)}` : ''}${ext}`
}
async function cleanupPendingUploads() {
  for (const row of db
    .prepare(
      "SELECT filename, storage, storage_path FROM pending_uploads WHERE draft_id IS NULL AND created_at < datetime('now', '-1 day')",
    )
    .all()) {
    db.prepare('DELETE FROM pending_uploads WHERE filename = ?').run(row.filename)
    if (!isReferenced(row.filename))
      await deleteImage(row.filename, row.storage, row.storage_path || row.filename).catch(() => {})
  }
}
