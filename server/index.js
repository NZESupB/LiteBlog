// 应用入口:API 路由 + 静态资源服务
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createHash } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { db, UPLOAD_DIR, hashPassword, verifyPassword, getSetting, setSetting } from './db.js'
import { sessionMiddleware, requireAuth, createSession, clearSession } from './auth.js'

const PORT = Number(process.env.PORT) || 3000

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }
const UPLOAD_NAME_RE = /^[a-f0-9]{16}\.(jpg|png|webp|gif)$/
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }

const app = new Hono()
app.use('*', sessionMiddleware)

// 站点配置:数据库可后台修改,环境变量作为初始值
function siteConfig() {
  return {
    title: getSetting('title', process.env.SITE_TITLE || '我们的日常'),
    anniversary: getSetting('anniversary', process.env.ANNIVERSARY || ''),
    privateMode: getSetting('private_mode', process.env.PRIVATE_MODE || 'false') === 'true',
  }
}

// 私密模式下,内容类接口与图片必须登录后访问
async function requireViewer(c, next) {
  if (siteConfig().privateMode && !c.get('user')) return c.json({ error: '请先登录' }, 401)
  await next()
}

// ---------- 站点信息与账号 ----------

app.get('/api/site', (c) => {
  return c.json({ ...siteConfig(), user: c.get('user') })
})

// 后台设置(登录后修改,即时生效)
app.put('/api/settings', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const title = String(body.title ?? '').trim()
  const anniversary = String(body.anniversary ?? '').trim()
  const privateMode = body.privateMode === true || body.privateMode === 'true'
  if (!title) return c.json({ error: '站点名不能为空' }, 400)
  if (anniversary && !/^\d{4}-\d{2}-\d{2}$/.test(anniversary)) {
    return c.json({ error: '纪念日格式应为 YYYY-MM-DD' }, 400)
  }
  setSetting('title', title)
  setSetting('anniversary', anniversary)
  setSetting('private_mode', privateMode ? 'true' : 'false')
  return c.json({ ok: true, ...siteConfig() })
})

app.post('/api/login', async (c) => {
  const { name, password } = await c.req.json().catch(() => ({}))
  const user = name && db.prepare('SELECT * FROM users WHERE name = ?').get(name)
  if (!user || !verifyPassword(String(password || ''), user.pass_hash)) {
    return c.json({ error: '昵称或密码错误' }, 401)
  }
  await createSession(c, user)
  return c.json({ user: { id: user.id, name: user.name } })
})

app.post('/api/logout', (c) => {
  clearSession(c)
  return c.json({ ok: true })
})

app.post('/api/password', requireAuth, async (c) => {
  const { oldPassword, newPassword } = await c.req.json().catch(() => ({}))
  if (!newPassword || String(newPassword).length < 6) {
    return c.json({ error: '新密码至少 6 位' }, 400)
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(c.get('user').id)
  if (!verifyPassword(String(oldPassword || ''), user.pass_hash)) {
    return c.json({ error: '原密码错误' }, 401)
  }
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(newPassword)), user.id)
  return c.json({ ok: true })
})

// ---------- 动态 ----------

function attachImages(posts) {
  if (posts.length === 0) return posts
  const ids = posts.map((p) => p.id)
  const rows = db
    .prepare(`SELECT id, post_id, filename FROM images WHERE post_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, id`)
    .all(...ids)
  const byPost = new Map(posts.map((p) => [p.id, (p.images = [])]))
  for (const r of rows) byPost.get(r.post_id).push({ id: r.id, url: `/uploads/${r.filename}` })
  return posts
}

app.get('/api/posts', requireViewer, (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 20, 50)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  const total = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c
  const posts = db
    .prepare(`
      SELECT p.id, p.content, p.created_at, p.updated_at, p.user_id, u.name AS author
      FROM posts p JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`)
    .all(limit, offset)
  return c.json({ total, posts: attachImages(posts) })
})

async function saveImage(file) {
  const ext = IMAGE_EXT[file.type]
  if (!ext) throw new Error(`不支持的图片类型: ${file.type || '未知'}`)
  if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10MB')
  const buf = Buffer.from(await file.arrayBuffer())
  const filename = createHash('sha256').update(buf).digest('hex').slice(0, 16) + ext
  await writeFile(path.join(UPLOAD_DIR, filename), buf)
  return filename
}

// 若没有其他动态引用同名文件(内容哈希去重),则删除磁盘文件
async function removeImageFile(filename) {
  const ref = db.prepare('SELECT COUNT(*) AS c FROM images WHERE filename = ?').get(filename).c
  if (ref === 0) await unlink(path.join(UPLOAD_DIR, filename)).catch(() => {})
}

app.post('/api/posts', requireAuth, async (c) => {
  const form = await c.req.formData()
  const content = String(form.get('content') || '').trim()
  const files = form.getAll('images').filter((f) => typeof f === 'object' && f.size > 0)
  if (!content && files.length === 0) return c.json({ error: '写点什么或传张图吧' }, 400)

  let filenames
  try {
    filenames = await Promise.all(files.map(saveImage))
  } catch (e) {
    return c.json({ error: e.message }, 400)
  }
  const { lastInsertRowid: postId } = db
    .prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)')
    .run(c.get('user').id, content)
  const insertImg = db.prepare('INSERT INTO images (post_id, filename, sort) VALUES (?, ?, ?)')
  filenames.forEach((f, i) => insertImg.run(postId, f, i))
  return c.json({ id: Number(postId) })
})

function ownPostOr404(c) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(c.req.param('id')))
  if (!post) return [null, c.json({ error: '动态不存在' }, 404)]
  if (post.user_id !== c.get('user').id) return [null, c.json({ error: '只能操作自己发布的动态' }, 403)]
  return [post, null]
}

app.put('/api/posts/:id', requireAuth, async (c) => {
  const [post, err] = ownPostOr404(c)
  if (err) return err
  const form = await c.req.formData()
  const content = String(form.get('content') || '').trim()
  // keep 为保留的现有图片 id 列表,未列出的将被移除
  let keep
  try {
    keep = JSON.parse(String(form.get('keep') || '[]')).map(Number)
  } catch {
    return c.json({ error: 'keep 参数格式错误' }, 400)
  }
  const files = form.getAll('images').filter((f) => typeof f === 'object' && f.size > 0)

  const existing = db.prepare('SELECT id, filename FROM images WHERE post_id = ? ORDER BY sort, id').all(post.id)
  const kept = existing.filter((img) => keep.includes(img.id))
  if (!content && kept.length + files.length === 0) return c.json({ error: '写点什么或传张图吧' }, 400)

  let filenames
  try {
    filenames = await Promise.all(files.map(saveImage))
  } catch (e) {
    return c.json({ error: e.message }, 400)
  }

  const removed = existing.filter((img) => !keep.includes(img.id))
  const delImg = db.prepare('DELETE FROM images WHERE id = ?')
  for (const img of removed) delImg.run(img.id)
  const insertImg = db.prepare('INSERT INTO images (post_id, filename, sort) VALUES (?, ?, ?)')
  kept.forEach((img, i) => db.prepare('UPDATE images SET sort = ? WHERE id = ?').run(i, img.id))
  filenames.forEach((f, i) => insertImg.run(post.id, f, kept.length + i))
  db.prepare("UPDATE posts SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, post.id)
  for (const img of removed) await removeImageFile(img.filename)
  return c.json({ ok: true })
})

app.delete('/api/posts/:id', requireAuth, async (c) => {
  const [post, err] = ownPostOr404(c)
  if (err) return err
  const imgs = db.prepare('SELECT filename FROM images WHERE post_id = ?').all(post.id)
  db.prepare('DELETE FROM images WHERE post_id = ?').run(post.id)
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id)
  for (const img of imgs) await removeImageFile(img.filename)
  return c.json({ ok: true })
})

// ---------- 相册 ----------

app.get('/api/gallery', requireViewer, (c) => {
  const rows = db
    .prepare(`
      SELECT i.id, i.filename, i.post_id, p.created_at, u.name AS author
      FROM images i JOIN posts p ON p.id = i.post_id JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC, i.sort, i.id`)
    .all()
  return c.json({ images: rows.map((r) => ({ ...r, url: `/uploads/${r.filename}` })) })
})

// ---------- 图片文件与静态资源 ----------

app.get('/uploads/:name', requireViewer, async (c) => {
  const name = c.req.param('name')
  if (!UPLOAD_NAME_RE.test(name)) return c.text('Not Found', 404)
  try {
    const buf = await readFile(path.join(UPLOAD_DIR, name))
    return c.body(buf, 200, {
      'Content-Type': MIME_BY_EXT[path.extname(name)],
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
  } catch {
    return c.text('Not Found', 404)
  }
})

app.use('*', serveStatic({ root: './public' }))

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`${siteConfig().title} 已启动: http://localhost:${PORT}`)
})
