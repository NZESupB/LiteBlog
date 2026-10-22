import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db, AVATAR_DIR } from '../db.js'
import { LOCAL, WEBDAV, getImage, openStream } from '../storage.js'
import {
  AVATAR_NAME_RE,
  AVATAR_MIME_BY_EXT,
  UPLOAD_NAME_RE,
  MIME_BY_EXT,
  siteConfig,
  isVideoName,
  mediaPayload,
  requireViewer,
} from '../services/site.js'

export function registerMedia(app) {
  app.get('/api/gallery', requireViewer, (c) => {
    const rows = db
      .prepare(
        `SELECT i.id, i.filename, i.post_id, i.type, i.motion_filename, i.poster_filename, i.duration, p.created_at, u.name AS author
      FROM images i JOIN posts p ON p.id = i.post_id JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC, i.sort, i.id`,
      )
      .all()
    return c.json({
      images: rows.map((row) => ({
        id: row.id,
        post_id: row.post_id,
        created_at: row.created_at,
        author: row.author,
        ...mediaPayload(row),
      })),
    })
  })
  app.get('/avatars/:name', async (c) => {
    const name = c.req.param('name')
    if (
      !AVATAR_NAME_RE.test(name) ||
      !db.prepare('SELECT 1 FROM users WHERE avatar_filename = ? LIMIT 1').get(name)
    )
      return c.text('Not Found', 404)
    try {
      return c.body(await readFile(path.join(AVATAR_DIR, name)), 200, {
        'Content-Type': AVATAR_MIME_BY_EXT[path.extname(name)],
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    } catch {
      return c.text('Not Found', 404)
    }
  })
  app.get('/uploads/:name', async (c) => {
    const name = c.req.param('name')
    if (!UPLOAD_NAME_RE.test(name)) return c.text('Not Found', 404)
    const row = db
      .prepare(
        `SELECT i.*, p.public_images FROM images i JOIN posts p ON p.id = i.post_id WHERE i.filename = ? OR i.motion_filename = ? OR i.poster_filename = ? LIMIT 1`,
      )
      .get(name, name, name)
    if (siteConfig().privateMode && !c.get('user') && !row?.public_images)
      return c.json({ error: '请先登录' }, 401)
    const pending = row
      ? null
      : db.prepare('SELECT storage, storage_path FROM pending_uploads WHERE filename = ? LIMIT 1').get(name)
    const prefix = row?.filename === name ? '' : row?.motion_filename === name ? 'motion_' : 'poster_'
    const backend = row ? row[prefix + 'storage'] || row.storage : pending?.storage || LOCAL
    const storagePath = row
      ? (prefix ? row[prefix + 'path'] : row.storage_path) || name
      : pending?.storage_path || name
    if (![LOCAL, WEBDAV].includes(backend)) return c.text('Not Found', 404)
    const contentType = MIME_BY_EXT[path.extname(name).toLowerCase()]
    if (!contentType) return c.text('Not Found', 404)
    try {
      if (!isVideoName(name))
        return c.body(await getImage(name, backend, storagePath), 200, {
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=31536000, immutable',
        })
      const opened = await openStream(name, backend, storagePath, c.req.header('range'))
      const headers = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=31536000, immutable',
      }
      if (opened.partial && opened.total != null && opened.end != null) {
        headers['Content-Range'] = `bytes ${opened.start}-${opened.end}/${opened.total}`
        headers['Content-Length'] = String(opened.end - opened.start + 1)
        return c.body(opened.stream, 206, headers)
      }
      if (opened.total != null) headers['Content-Length'] = String(opened.total)
      return c.body(opened.stream, 200, headers)
    } catch (error) {
      if (backend === LOCAL) return c.text('Not Found', 404)
      console.warn(`读取 WebDAV 媒体 ${name} 失败: ${error.message}`)
      return c.text('Bad Gateway', 502)
    }
  })
}
