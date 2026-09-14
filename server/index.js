// 应用入口:API 路由 + 静态资源服务
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AVATAR_DIR, TMP_DIR, db, hashPassword, verifyPassword, getSetting, setSetting, getUserSetting, setUserSetting } from './db.js'
import { sessionMiddleware, requireAuth, createSession, clearSession } from './auth.js'
import { LOCAL, WEBDAV, activeBackend, putImage, putFileFromTemp, getImage, openStream, deleteImage } from './storage.js'
import { vapidPublicKey, saveSubscription, removeSubscription, pushToUser, isValidSubscription } from './push.js'
import * as webdav from './webdav.js'
import { llmApp } from './llm.js'
import { imageJobsApp, ensureDraft, draftOwnedBy, abandonDraft } from './image-jobs.js'
import { configValue } from './config.js'

const PORT = Number(configValue('server.port', 3000)) || 3000
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_AVATAR_BYTES = 10 * 1024 * 1024
// 视频不转码原样上传,上限走配置(默认 200MB)
const MAX_VIDEO_BYTES = Math.max(1, Math.trunc(Number(configValue('media.maxVideoBytes', 200 * 1024 * 1024)) || 200 * 1024 * 1024))
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' }
// 新格式 YYYYMMDD-HHMMSS-<hash8>,旧格式为 16 位内容哈希,两者都要能读
const UPLOAD_NAME_RE = /^(?:[a-f0-9]{16}|\d{8}-\d{6}-[a-f0-9]{8}(?:-[a-zA-Z0-9-]+)?|ai-[a-zA-Z0-9-]+)\.(jpg|png|webp|gif|mp4|mov|webm)$/
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' }
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm'])
const isVideoName = (name) => VIDEO_EXTENSIONS.has(path.extname(String(name)).toLowerCase())
const AVATAR_MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const AVATAR_NAME_RE = /^avatar-\d+-\d+-[a-f0-9]{12}\.(jpg|png|webp)$/
// 网盘里按时间查找方便:文件名带日期。用 Intl 取东八区,不依赖容器 tzdata
const FILE_TZ_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

export const app = new Hono()
app.use('*', sessionMiddleware)

// 站点配置:数据库可后台修改,config.json 作为初始值
function siteConfig() {
  const privateMode = configValue('site.privateMode', false)
  return {
    title: getSetting('title', String(configValue('site.title', '我们的日常'))),
    anniversary: getSetting('anniversary', String(configValue('site.anniversary', ''))),
    privateMode: getSetting('private_mode', String(privateMode).toLowerCase()) === 'true',
  }
}

function avatarUrl(filename) {
  return filename ? `/avatars/${filename}` : null
}

function attachAvatars(rows) {
  for (const row of rows) {
    row.avatarUrl = avatarUrl(row.avatar_filename)
    delete row.avatar_filename
    if (Object.prototype.hasOwnProperty.call(row, 'reply_avatar_filename')) {
      row.replyAvatarUrl = avatarUrl(row.reply_avatar_filename)
      delete row.reply_avatar_filename
    }
  }
  return rows
}

// 私密模式下,相册聚合等纯图资源仍需登录;/uploads 已按文章「公开图片」开关自管鉴权
async function requireViewer(c, next) {
  if (siteConfig().privateMode && !c.get('user')) return c.json({ error: '请先登录' }, 401)
  await next()
}

// ---------- 站点信息与账号 ----------

app.get('/api/site', (c) => {
  // reactionEmojis 由服务端统一下发,避免前后端两份定义漂移
  return c.json({ ...siteConfig(), user: c.get('user'), reactionEmojis: [...REACTION_EMOJIS] })
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
  const body = (await c.req.json().catch(() => ({}))) || {}
  // 兼容旧版客户端:旧版把登录账号放在 name 字段
  const username = String(body.username ?? body.name ?? '').trim()
  const password = body.password
  const user = username && db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user || !verifyPassword(String(password || ''), user.pass_hash)) {
    return c.json({ error: '登录账号或密码错误' }, 401)
  }
  await createSession(c, user)
  return c.json({ user: { id: user.id, username: user.username, name: user.name, displayName: user.name, avatarUrl: avatarUrl(user.avatar_filename) } })
})

app.post('/api/logout', (c) => {
  clearSession(c)
  return c.json({ ok: true })
})

app.post('/api/profile', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) || {}
  const me = c.get('user')
  const current = db.prepare('SELECT username, name FROM users WHERE id = ?').get(me.id)
  if (!current) return c.json({ error: '请重新登录' }, 401)
  const hasUsername = Object.prototype.hasOwnProperty.call(body, 'username')
  const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'displayName')
  // 旧客户端只提交 name,按旧语义同步修改登录账号和显示名称
  const isLegacyProfile = !hasUsername && !hasDisplayName && Object.prototype.hasOwnProperty.call(body, 'name')
  const requestedUsername = hasUsername ? body.username : isLegacyProfile ? body.name : current.username
  const requestedDisplayName = hasDisplayName ? body.displayName : body.name
  const newUsername = String(requestedUsername ?? current.username ?? me.username ?? '').trim()
  const newName = String(requestedDisplayName ?? current.name ?? me.displayName ?? me.name ?? '').trim()
  if (!newUsername || newUsername.length > 24 || newUsername.includes(':')) {
    return c.json({ error: '登录账号需为 1-24 个字符,且不能包含冒号' }, 400)
  }
  if (!newName || newName.length > 24) {
    return c.json({ error: '显示名称需为 1-24 个字符' }, 400)
  }
  const takenUsername = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, me.id)
  if (takenUsername) return c.json({ error: '登录账号已被占用' }, 400)
  const takenName = db.prepare('SELECT id FROM users WHERE name = ? AND id != ?').get(newName, me.id)
  if (takenName) return c.json({ error: '显示名称已被占用' }, 400)
  try {
    db.prepare('UPDATE users SET username = ?, name = ? WHERE id = ?').run(newUsername, newName, me.id)
  } catch (error) {
    if (error.code?.includes('SQLITE_CONSTRAINT') || error.errcode === 19 || error.errcode === 2067) {
      return c.json({ error: '登录账号或显示名称已被占用' }, 400)
    }
    throw error
  }
  // 重新签发会话,JWT 中同步保存登录账号和显示名称
  await createSession(c, { id: me.id, username: newUsername, name: newName })
  const avatar = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(me.id)
  return c.json({ ok: true, username: newUsername, name: newName, displayName: newName, avatarUrl: avatarUrl(avatar?.avatar_filename) })
})

function detectAvatarType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  return null
}

app.post('/api/profile/avatar', requireAuth, async (c) => {
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('avatar')
  if (!file || typeof file !== 'object' || file.size === 0) return c.json({ error: '没有收到头像图片' }, 400)
  if (file.size > MAX_AVATAR_BYTES) return c.json({ error: '头像不能超过 10MB' }, 400)
  const buf = Buffer.from(await file.arrayBuffer())
  const ext = detectAvatarType(buf)
  if (!ext) return c.json({ error: '头像仅支持 JPEG、PNG 或 WebP' }, 400)
  const me = c.get('user')
  const hash = createHash('sha256').update(buf).digest('hex')
  const filename = `avatar-${me.id}-${Date.now()}-${hash.slice(0, 12)}${ext}`
  const target = path.join(AVATAR_DIR, filename)
  await writeFile(target, buf)
  const current = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(me.id)
  try {
    db.prepare('UPDATE users SET avatar_filename = ? WHERE id = ?').run(filename, me.id)
  } catch (error) {
    await unlink(target).catch(() => {})
    throw error
  }
  if (current?.avatar_filename && AVATAR_NAME_RE.test(current.avatar_filename)) {
    await unlink(path.join(AVATAR_DIR, current.avatar_filename)).catch(() => {})
  }
  return c.json({ ok: true, avatarUrl: avatarUrl(filename) })
})

app.delete('/api/profile/avatar', requireAuth, async (c) => {
  const me = c.get('user')
  const current = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(me.id)
  db.prepare('UPDATE users SET avatar_filename = NULL WHERE id = ?').run(me.id)
  if (current?.avatar_filename && AVATAR_NAME_RE.test(current.avatar_filename)) {
    await unlink(path.join(AVATAR_DIR, current.avatar_filename)).catch(() => {})
  }
  return c.json({ ok: true, avatarUrl: null })
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

// 一个媒体项对前端的形状:{id, type, url} 为必有;视频另带 poster/duration,实况图另带 live/motion。
// url 字段保持原名不变,旧客户端拿到的仍然是能直接用的地址。
function mediaPayload(row) {
  const media = { id: row.id, type: row.type === 'video' ? 'video' : 'image', url: `/uploads/${row.filename}` }
  if (media.type === 'video') {
    if (row.poster_filename) media.poster = `/uploads/${row.poster_filename}`
    if (row.duration != null) media.duration = row.duration
  } else if (row.motion_filename) {
    media.live = true
    media.motion = `/uploads/${row.motion_filename}`
  }
  return media
}

function attachImages(posts) {
  if (posts.length === 0) return posts
  const ids = posts.map((p) => p.id)
  const rows = db
    .prepare(`SELECT id, post_id, filename, type, motion_filename, poster_filename, duration FROM images WHERE post_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, id`)
    .all(...ids)
  const byPost = new Map(posts.map((p) => [p.id, (p.images = [])]))
  for (const r of rows) byPost.get(r.post_id).push(mediaPayload(r))
  return posts
}

function attachReactions(posts, userId = null) {
  if (posts.length === 0) return posts
  const ids = posts.map((p) => p.id)
  const rows = db.prepare(`
    SELECT post_id, emoji, COUNT(*) AS count,
      SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reacted
    FROM post_reactions
    WHERE post_id IN (${ids.map(() => '?').join(',')})
    GROUP BY post_id, emoji
    ORDER BY post_id, emoji`).all(userId || 0, ...ids)
  const byPost = new Map(posts.map((p) => [p.id, (p.reactions = [])]))
  for (const row of rows) byPost.get(row.post_id).push({ emoji: row.emoji, count: row.count, reacted: Boolean(row.reacted) })
  return posts
}

// 编辑/删除窗口以服务端时间为准:前端只读 canEdit 标志,不受客户端时钟偏差影响
function withCanEdit(posts, user) {
  for (const p of posts) p.canEdit = Boolean(user && p.user_id === user.id && withinEditWindow(p))
  return posts
}

// 分页游标:与列表排序键 (created_at, id) 同构,格式 `<created_at>|<id>`。
// 格式只在服务端产出与消费,前端拿到 nextCursor 原样回传,不自己拼装。
function parseCursor(raw) {
  if (!raw) return null
  const sep = raw.lastIndexOf('|')
  if (sep < 0) return null
  const at = raw.slice(0, sep)
  const id = Number(raw.slice(sep + 1))
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) || !Number.isSafeInteger(id) || id < 0) return null
  return { at, id }
}

// 时区偏移(分钟,东八区为 480)。created_at 存 UTC,而月份归属要按用户本地时区算,
// 否则东八区每月最后 8 小时的动态会被归到上个月,与前端 dateLabel 的显示错位。
// 取的是前端当前时刻的偏移:有夏令时的时区下,历史月份的边界记录可能差一天;Asia/Shanghai 无夏令时,本项目场景精确。
function tzMinutes(raw) {
  const value = Number(raw)
  return Number.isFinite(value) && Math.abs(value) <= 840 ? Math.trunc(value) : 0
}

// 跳到某月 = 从该月本地时间的月末边界往前取。边界本身(下月 1 日 00:00:00)属于下个月,
// 用 id = 0 把恰好等于边界的记录排除掉,跳月与翻页因此共用同一个「严格早于游标」的查询。
function monthCursor(month, tz) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month ?? ''))) return null
  const [year, m] = month.split('-').map(Number)
  // Date.UTC 的月份是 0-based,直接传 m 即为下个月
  const at = new Date(Date.UTC(year, m, 1) - tz * 60000).toISOString().slice(0, 19).replace('T', ' ')
  return { at, id: 0 }
}

app.get('/api/posts', (c) => {
  const rawLimit = c.req.query('limit')
  const limit = rawLimit == null ? 20 : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return c.json({ error: '分页参数不合法' }, 400)
  }
  const tz = tzMinutes(c.req.query('tz'))
  const rawCursor = c.req.query('cursor')
  const rawMonth = c.req.query('month')
  const cursor = parseCursor(rawCursor) ?? monthCursor(rawMonth, tz)
  // 给了定位参数却解析不出游标,静默当第一页会表现成「跳月失败却显示最新」,极难排查
  if (!cursor && (rawCursor || rawMonth)) return c.json({ error: '分页参数不合法' }, 400)

  const total = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c
  // 多取一条探边界:比 posts.length === limit 准,末页刚好整页时不会多出一次空加载
  const rows = db
    .prepare(`
      SELECT p.id, p.content, p.created_at, p.updated_at, p.user_id, p.public_text, p.public_images, u.name AS author, u.avatar_filename
      FROM posts p JOIN users u ON u.id = p.user_id
      ${cursor ? 'WHERE (p.created_at, p.id) < (?, ?)' : ''}
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
    .all(...(cursor ? [cursor.at, cursor.id] : []), limit + 1)
  const hasMore = rows.length > limit
  const posts = hasMore ? rows.slice(0, limit) : rows
  const last = posts[posts.length - 1]
  const nextCursor = hasMore && last ? `${last.created_at}|${last.id}` : null

  const withImages = withCanEdit(attachAvatars(attachReactions(attachImages(posts), c.get('user')?.id)), c.get('user'))
  // 私密模式下未登录访客:按文章开关决定可见性,默认全隐
  if (siteConfig().privateMode && !c.get('user')) {
    for (const p of withImages) {
      if (!p.public_text) p.content = ''
      if (!p.public_images) p.images = []
    }
  }
  return c.json({ total, hasMore, nextCursor, posts: withImages })
})

// 归档:按本地时区分月聚合条数,供时间轴的年月跳转用。只暴露「哪个月有几条」,
// 与 /api/posts 对未登录访客也返回 total 的口径一致,因此不加登录守卫。
app.get('/api/posts/archive', (c) => {
  const tz = tzMinutes(c.req.query('tz'))
  const months = db
    .prepare(`
      SELECT strftime('%Y-%m', created_at, ?) AS month, COUNT(*) AS count
      FROM posts GROUP BY month ORDER BY month DESC`)
    .all(`${tz} minutes`)
  return c.json({ months, total: months.reduce((sum, row) => sum + row.count, 0) })
})

// 单条动态(站内通知跳转的落地页),访客可见性规则与列表一致
app.get('/api/posts/:id', (c) => {
  const post = db
    .prepare(`
      SELECT p.id, p.content, p.created_at, p.updated_at, p.user_id, p.public_text, p.public_images, u.name AS author, u.avatar_filename
      FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`)
    .get(Number(c.req.param('id')))
  if (!post) return c.json({ error: '动态不存在' }, 404)
  attachAvatars(attachReactions(attachImages([post]), c.get('user')?.id))
  withCanEdit([post], c.get('user'))
  if (siteConfig().privateMode && !c.get('user')) {
    if (!post.public_text) post.content = ''
    if (!post.public_images) post.images = []
  }
  return c.json({ post })
})

// ---------- 图片上传(选图即上传,发布时才归属动态) ----------

// 草稿只保存归属和生命周期,正文与编辑器状态在浏览器本地保存。
app.post('/api/drafts', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const postId = Number(body.postId) || null
  const draftId = ensureDraft(c.get('user').id, body.id, postId)
  return c.json({ id: draftId })
})

app.get('/api/drafts/:id', requireAuth, (c) => {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id)
  if (!draft) return c.json({ error: '草稿不存在' }, 404)
  const pending = db.prepare('SELECT filename, hash, storage, draft_id, storage_path, created_at FROM pending_uploads WHERE draft_id = ? AND user_id = ? ORDER BY created_at, filename').all(draft.id, c.get('user').id)
  const jobs = db.prepare('SELECT id, status, filename, storage, storage_path, mime, error, created_at, updated_at, finished_at FROM image_jobs WHERE draft_id = ? AND user_id = ? ORDER BY created_at DESC').all(draft.id, c.get('user').id)
  return c.json({ draft, pending, jobs })
})

app.delete('/api/drafts/:id', requireAuth, async (c) => {
  const ok = await abandonDraft(c.get('user').id, c.req.param('id'))
  return c.json({ ok })
})

app.get('/api/drafts/:id/preview/:name', requireAuth, async (c) => {
  const draft = db.prepare('SELECT id FROM drafts WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id)
  const name = c.req.param('name')
  if (!draft || !UPLOAD_NAME_RE.test(name)) return c.text('Not Found', 404)
  const row = db.prepare('SELECT storage, storage_path FROM pending_uploads WHERE filename = ? AND draft_id = ? AND user_id = ?').get(name, draft.id, c.get('user').id)
  if (!row) return c.text('Not Found', 404)
  try {
    const buf = await getImage(name, row.storage, row.storage_path || name)
    return c.body(buf, 200, { 'Content-Type': MIME_BY_EXT[path.extname(name)], 'Cache-Control': 'private, max-age=300' })
  } catch {
    return c.text('Bad Gateway', 502)
  }
})

function stampedName(hash, ext, unique = false) {
  const p = Object.fromEntries(FILE_TZ_FORMAT.formatToParts(new Date()).map((x) => [x.type, x.value]))
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${hash.slice(0, 8)}${unique ? `-${randomUUID().slice(0, 8)}` : ''}${ext}`
}

// 该文件是否还被别处引用(动态主文件、实况配对视频、视频封面,或其他待引用记录),无引用才能删
function isReferenced(filename) {
  return Boolean(
    db.prepare('SELECT 1 FROM images WHERE filename = ? OR motion_filename = ? OR poster_filename = ? LIMIT 1')
      .get(filename, filename, filename) ||
    db.prepare('SELECT 1 FROM pending_uploads WHERE filename = ? LIMIT 1').get(filename),
  )
}

// 一个媒体项在存储后端上的全部文件:主文件 + 实况配对视频 + 视频封面。
// 三者各自记录后端(切换存储设置或失败重传时可能不是同一个),删除时逐个按自己的记录处理。
function mediaFiles(row) {
  const files = [{ filename: row.filename, storage: row.storage, path: row.storage_path || row.filename }]
  if (row.motion_filename) {
    files.push({ filename: row.motion_filename, storage: row.motion_storage || row.storage, path: row.motion_path || row.motion_filename })
  }
  if (row.poster_filename) {
    files.push({ filename: row.poster_filename, storage: row.poster_storage || row.storage, path: row.poster_path || row.poster_filename })
  }
  return files
}

// 选完图就上传但最终没发布的,超过一天视为孤儿清理掉
async function cleanupPendingUploads() {
  const stale = db.prepare("SELECT filename, storage, storage_path FROM pending_uploads WHERE draft_id IS NULL AND created_at < datetime('now', '-1 day')").all()
  for (const row of stale) {
    db.prepare('DELETE FROM pending_uploads WHERE filename = ?').run(row.filename)
    if (!isReferenced(row.filename)) await deleteImage(row.filename, row.storage, row.storage_path || row.filename).catch(() => {})
  }
}

app.post('/api/uploads', requireAuth, async (c) => {
  await cleanupPendingUploads()
  const form = await c.req.formData()
  const file = form.get('image')
  const draftId = String(form.get('draftId') || '').trim() || null
  if (draftId && !draftOwnedBy(c.get('user').id, draftId)) return c.json({ error: '草稿不存在或无权操作' }, 403)
  if (!file || typeof file !== 'object' || file.size === 0) return c.json({ error: '没有收到图片' }, 400)
  const ext = IMAGE_EXT[file.type]
  if (!ext) return c.json({ error: `不支持的图片类型: ${file.type || '未知'}` }, 400)
  if (file.size > MAX_IMAGE_BYTES) return c.json({ error: '单张图片不能超过 10MB' }, 400)

  const buf = Buffer.from(await file.arrayBuffer())
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
  // 内容去重只在当前用户/当前草稿范围内复用;跨账号或跨草稿时创建独立文件,避免覆盖待引用归属。
  const userId = c.get('user').id
  const pending = db.prepare(`SELECT filename, hash, storage, storage_path, user_id, draft_id
    FROM pending_uploads WHERE hash = ? AND user_id = ? AND ${draftId ? 'draft_id = ?' : 'draft_id IS NULL'} LIMIT 1`)
    .get(...(draftId ? [hash, userId, draftId] : [hash, userId]))
  const ownedImage = db.prepare(`SELECT i.filename, i.hash, i.storage, i.storage_path
    FROM images i JOIN posts p ON p.id = i.post_id
    WHERE i.hash = ? AND p.user_id = ? ORDER BY i.id LIMIT 1`).get(hash, userId)
  let exist = pending || null
  if (!exist && ownedImage) {
    const pendingAtName = db.prepare('SELECT user_id, draft_id, hash FROM pending_uploads WHERE filename = ? LIMIT 1').get(ownedImage.filename)
    const sameDraft = pendingAtName && pendingAtName.user_id === userId && pendingAtName.hash === hash
      && (pendingAtName.draft_id ?? null) === (draftId || null)
    if (!pendingAtName || sameDraft) exist = ownedImage
  }

  const filename = exist ? exist.filename : stampedName(hash, ext, Boolean(
    ownedImage
      || db.prepare('SELECT 1 FROM images WHERE hash = ? LIMIT 1').get(hash)
      || db.prepare('SELECT 1 FROM pending_uploads WHERE hash = ? LIMIT 1').get(hash),
  ))
  let storage = exist ? exist.storage : null
  if (!exist) {
    try {
      storage = await putImage(filename, buf, MIME_BY_EXT[ext], filename)
    } catch (e) {
      console.warn(`上传图片 ${filename} 失败: ${e.message}`)
      return c.json({ error: e.message }, 502)
    }
  }
  db.prepare(`INSERT INTO pending_uploads (filename, hash, storage, user_id, draft_id, storage_path) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(filename) DO UPDATE SET user_id = excluded.user_id, draft_id = excluded.draft_id,
              storage_path = excluded.storage_path, created_at = datetime('now')`)
    .run(filename, hash, storage, userId, draftId, exist?.storage_path || filename)
  return c.json({ filename, url: `/uploads/${filename}` })
})

// 视频上传:原始字节流(不是 multipart),先流式落到 data/tmp 临时文件并边写边算 sha256、边校验上限,
// 再转存到当前激活的存储后端。全程不把视频读进内存 —— 200MB 的片段读进内存会直接压垮最低配 VPS。
app.post('/api/uploads/video', requireAuth, async (c) => {
  const draftId = String(c.req.query('draftId') || '').trim() || null
  if (draftId && !draftOwnedBy(c.get('user').id, draftId)) return c.json({ error: '草稿不存在或无权操作' }, 403)
  const contentType = String(c.req.header('content-type') || '').split(';')[0].trim().toLowerCase()
  const ext = VIDEO_EXT[contentType]
  if (!ext) return c.json({ error: '不支持的视频格式,请上传 MP4 / MOV / WebM' }, 400)
  if (Number(c.req.header('content-length') || 0) > MAX_VIDEO_BYTES) {
    return c.json({ error: `单个视频不能超过 ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB` }, 413)
  }
  if (!c.req.raw.body) return c.json({ error: '没有收到视频' }, 400)
  await cleanupPendingUploads()

  const tempPath = path.join(TMP_DIR, `${randomUUID()}.part`)
  const hash = createHash('sha256')
  let size = 0
  let tooLarge = false
  try {
    await pipeline(
      Readable.fromWeb(c.req.raw.body),
      new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length
          // 不信任客户端声明的 Content-Length:边写边校验,超限立刻中止并删除半截文件
          if (size > MAX_VIDEO_BYTES) { tooLarge = true; done(new Error('VIDEO_TOO_LARGE')); return }
          hash.update(chunk)
          done(null, chunk)
        },
      }),
      createWriteStream(tempPath),
    )
  } catch (e) {
    await unlink(tempPath).catch(() => {})
    if (tooLarge) return c.json({ error: `单个视频不能超过 ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB` }, 413)
    console.warn(`接收视频失败: ${e.message}`)
    return c.json({ error: '视频上传中断,请重试' }, 400)
  }
  if (size === 0) {
    await unlink(tempPath).catch(() => {})
    return c.json({ error: '没有收到视频' }, 400)
  }

  // 视频不参与内容去重(文件名里放随机段),hash 仍记下来供以后排查与迁移使用
  const digest = hash.digest('hex')
  const filename = stampedName(randomBytes(8).toString('hex'), ext)
  let storage
  try {
    storage = await putFileFromTemp(filename, tempPath, size, contentType, filename)
  } catch (e) {
    await unlink(tempPath).catch(() => {})
    console.warn(`转存视频 ${filename} 失败: ${e.message}`)
    return c.json({ error: e.message }, 502)
  }
  db.prepare(`INSERT INTO pending_uploads (filename, hash, storage, user_id, draft_id, storage_path) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(filename) DO UPDATE SET user_id = excluded.user_id, draft_id = excluded.draft_id,
              storage_path = excluded.storage_path, created_at = datetime('now')`)
    .run(filename, digest, storage, c.get('user').id, draftId, filename)
  return c.json({ filename, url: `/uploads/${filename}`, size })
})

// 编辑框里点 × 撤掉还没发布的图:连带把网盘上的文件删掉。幂等
app.delete('/api/uploads/:name', requireAuth, async (c) => {
  const name = c.req.param('name')
  const row = db.prepare('SELECT storage, storage_path FROM pending_uploads WHERE filename = ? AND user_id = ?').get(name, c.get('user').id)
  if (!row) return c.json({ ok: true })
  db.prepare('DELETE FROM pending_uploads WHERE filename = ?').run(name)
  if (!isReferenced(name)) await deleteImage(name, row.storage, row.storage_path || name).catch(() => {})
  return c.json({ ok: true })
})

// 单个文件名的归属解析:只接受当前用户/当前草稿的待引用文件,已发布文件仅允许原作者在编辑时复用,
// 避免猜文件名跨账号挂载别人的私密图片。
function lookupUploadable(name, userId, draftId = null) {
  if (!UPLOAD_NAME_RE.test(name)) throw new Error('媒体参数不合法')
  const row =
    (draftId
      ? db.prepare('SELECT filename, hash, storage, storage_path FROM pending_uploads WHERE filename = ? AND user_id = ? AND draft_id = ?').get(name, userId, draftId)
      : db.prepare('SELECT filename, hash, storage, storage_path FROM pending_uploads WHERE filename = ? AND user_id = ? AND draft_id IS NULL').get(name, userId)) ||
    db.prepare(`SELECT i.filename, i.hash, i.storage, i.storage_path
      FROM images i JOIN posts p ON p.id = i.post_id
      WHERE i.filename = ? AND p.user_id = ? LIMIT 1`).get(name, userId)
  if (!row) throw new Error('媒体不存在或已过期,请重新上传')
  return row
}

// 把前端提交的媒体项换成可写入 images 的记录。元素既接受旧的纯文件名字符串,
// 也接受 { filename, motion, poster, duration } —— motion 是实况配对视频,poster 是视频封面。
function claimUploads(items, userId, draftId = null) {
  return items.map((raw) => {
    const item = typeof raw === 'string' ? { filename: raw } : (raw && typeof raw === 'object' ? raw : {})
    const filename = String(item.filename || '')
    const base = lookupUploadable(filename, userId, draftId)
    const motionName = String(item.motion || '')
    const posterName = String(item.poster || '')
    if (motionName && !isVideoName(motionName)) throw new Error('实况配对文件必须是视频')
    if (posterName && isVideoName(posterName)) throw new Error('视频封面必须是图片')
    const duration = Number(item.duration)
    return {
      ...base,
      motion: motionName ? lookupUploadable(motionName, userId, draftId) : null,
      poster: posterName ? lookupUploadable(posterName, userId, draftId) : null,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    }
  })
}

function attachToPost(postId, claimed, startSort) {
  const insertImg = db.prepare(`INSERT INTO images
    (post_id, filename, sort, storage, hash, storage_path, type,
     motion_filename, motion_storage, motion_path, poster_filename, poster_storage, poster_path, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const dropPending = db.prepare('DELETE FROM pending_uploads WHERE filename = ?')
  claimed.forEach((media, i) => {
    const motion = media.motion
    const poster = media.poster
    insertImg.run(
      postId, media.filename, startSort + i, media.storage, media.hash, media.storage_path || media.filename,
      isVideoName(media.filename) ? 'video' : 'image',
      motion?.filename ?? null, motion?.storage ?? null, motion ? (motion.storage_path || motion.filename) : null,
      poster?.filename ?? null, poster?.storage ?? null, poster ? (poster.storage_path || poster.filename) : null,
      media.duration ?? null,
    )
    for (const name of [media.filename, motion?.filename, poster?.filename]) if (name) dropPending.run(name)
  })
}

// 动态被删/改时移除其全部媒体文件(主文件 + 实况配对视频 + 视频封面):没有任何其他引用才真删
async function removeMediaFiles(row) {
  for (const file of mediaFiles(row)) {
    if (isReferenced(file.filename)) continue
    await deleteImage(file.filename, file.storage, file.path).catch((e) => console.warn(`删除文件 ${file.filename} 失败: ${e.message}`))
  }
}

app.post('/api/posts', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const content = String(body.content || '').trim()
  const names = Array.isArray(body.images) ? body.images : []
  const draftId = String(body.draftId ?? '').trim() || null
  if (draftId && !draftOwnedBy(c.get('user').id, draftId)) return c.json({ error: '草稿不存在或无权操作' }, 403)
  if (draftId) {
    const draft = db.prepare('SELECT post_id, status FROM drafts WHERE id = ? AND user_id = ?').get(draftId, c.get('user').id)
    if (draft?.status === 'published' && draft.post_id) return c.json({ id: Number(draft.post_id), reused: true })
  }
  if (!content && names.length === 0) return c.json({ error: '写点什么或传张图吧' }, 400)

  let claimed
  try {
    claimed = claimUploads(names, c.get('user').id, draftId)
  } catch (e) {
    return c.json({ error: e.message }, 400)
  }
  const publicText = body.publicText ? 1 : 0
  const publicImages = body.publicImages ? 1 : 0
  // 插 posts + 转挂图片 + 清 pending 是一组操作,必须整体成败
  db.exec('BEGIN')
  let postId
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO posts (user_id, content, public_text, public_images) VALUES (?, ?, ?, ?)')
      .run(c.get('user').id, content, publicText, publicImages)
    postId = lastInsertRowid
    attachToPost(postId, claimed, 0)
    if (draftId) db.prepare("UPDATE drafts SET status = 'published', post_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(Number(postId), draftId, c.get('user').id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return c.json({ id: Number(postId) })
})

function ownPostOr404(c) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(c.req.param('id')))
  if (!post) return [null, c.json({ error: '动态不存在' }, 404)]
  if (post.user_id !== c.get('user').id) return [null, c.json({ error: '只能操作自己发布的动态' }, 403)]
  return [post, null]
}

// 编辑/删除仅限发布后 24 小时内
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000
function withinEditWindow(record) {
  return Date.now() - new Date(record.created_at.replace(' ', 'T') + 'Z').getTime() <= EDIT_WINDOW_MS
}

app.put('/api/posts/:id', requireAuth, async (c) => {
  const [post, err] = ownPostOr404(c)
  if (err) return err
  if (!withinEditWindow(post)) return c.json({ error: '发布超过 24 小时,不能再编辑' }, 403)
  const body = await c.req.json().catch(() => ({}))
  const content = String(body.content || '').trim()
  const draftId = String(body.draftId ?? '').trim() || null
  if (draftId && !draftOwnedBy(c.get('user').id, draftId)) return c.json({ error: '草稿不存在或无权操作' }, 403)
  // keep 为保留的现有图片 id 列表,未列出的将被移除
  const keep = Array.isArray(body.keep) ? body.keep.map(Number) : []
  const names = Array.isArray(body.images) ? body.images : []

  const existing = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort, id').all(post.id)
  const kept = existing.filter((img) => keep.includes(img.id))
  if (!content && kept.length + names.length === 0) return c.json({ error: '写点什么或传张图吧' }, 400)

  let claimed
  try {
    claimed = claimUploads(names, c.get('user').id, draftId)
  } catch (e) {
    return c.json({ error: e.message }, 400)
  }

  const removed = existing.filter((img) => !keep.includes(img.id))
  const publicText = body.publicText ? 1 : 0
  const publicImages = body.publicImages ? 1 : 0
  // 删图 / 重排 / 挂新图 / 改正文是一组操作,包事务避免半完成状态
  db.exec('BEGIN')
  try {
    const delImg = db.prepare('DELETE FROM images WHERE id = ?')
    for (const img of removed) delImg.run(img.id)
    kept.forEach((img, i) => db.prepare('UPDATE images SET sort = ? WHERE id = ?').run(i, img.id))
    attachToPost(post.id, claimed, kept.length)
    db.prepare("UPDATE posts SET content = ?, public_text = ?, public_images = ?, updated_at = datetime('now') WHERE id = ?").run(content, publicText, publicImages, post.id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  for (const img of removed) await removeMediaFiles(img)
  return c.json({ ok: true })
})

app.delete('/api/posts/:id', requireAuth, async (c) => {
  const [post, err] = ownPostOr404(c)
  if (err) return err
  if (!withinEditWindow(post)) return c.json({ error: '发布超过 24 小时,不能再删除' }, 403)
  const imgs = db.prepare('SELECT * FROM images WHERE post_id = ?').all(post.id)
  // 多步写必须整体成败:删一半崩了会留半条动态(外键级联也依赖 posts 删除本身)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM images WHERE post_id = ?').run(post.id)
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(post.id)
    db.prepare('DELETE FROM post_reactions WHERE post_id = ?').run(post.id)
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  for (const img of imgs) await removeMediaFiles(img)
  return c.json({ ok: true })
})

// ---------- 评论(仅登录用户,动态作者可管理本动态下的评论) ----------

function postOr404(c) {
  const post = db.prepare('SELECT id, user_id, public_text FROM posts WHERE id = ?').get(Number(c.req.param('id')))
  if (!post) return [null, c.json({ error: '动态不存在' }, 404)]
  return [post, null]
}

// 评论属于文字内容，私密模式下访客只可读取公开正文所属文章的评论。
app.get('/api/posts/:id/comments', (c) => {
  const [post, err] = postOr404(c)
  if (err) return err
  if (siteConfig().privateMode && !c.get('user') && !post.public_text) {
    return c.json({ error: '请先登录' }, 401)
  }
  const rows = db
    .prepare(`
      SELECT c.id, c.content, c.created_at, c.user_id, c.reply_to, u.name AS author, u.avatar_filename,
             reply_user.name AS reply_author, reply_user.avatar_filename AS reply_avatar_filename, reply.content AS reply_content
      FROM comments c JOIN users u ON u.id = c.user_id
      LEFT JOIN comments reply ON reply.id = c.reply_to AND reply.post_id = c.post_id
      LEFT JOIN users reply_user ON reply_user.id = reply.user_id
      WHERE c.post_id = ? ORDER BY c.id ASC`)
    .all(post.id)
  return c.json({ comments: attachAvatars(rows) })
})

app.post('/api/posts/:id/comments', requireAuth, async (c) => {
  const [post, err] = postOr404(c)
  if (err) return err
  const body = await c.req.json().catch(() => ({}))
  const content = String(body.content ?? '').trim()
  if (!content) return c.json({ error: '评论不能为空' }, 400)
  if (content.length > 500) return c.json({ error: '评论不超过 500 字' }, 400)

  const replyToId = body.replyToId == null || body.replyToId === '' ? null : Number(body.replyToId)
  if (replyToId !== null && (!Number.isSafeInteger(replyToId) || replyToId < 1)) {
    return c.json({ error: '回复目标无效' }, 400)
  }
  let replyAuthor = null
  let replyUserId = null
  if (replyToId !== null) {
    const reply = db
      .prepare('SELECT c.id, c.user_id, u.name AS author FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.post_id = ?')
      .get(replyToId, post.id)
    if (!reply) return c.json({ error: '回复的评论不存在' }, 400)
    replyAuthor = reply.author
    replyUserId = reply.user_id
  }

  const me = c.get('user')
  const { lastInsertRowid } = db
    .prepare('INSERT INTO comments (post_id, user_id, reply_to, content) VALUES (?, ?, ?, ?)')
    .run(post.id, me.id, replyToId, content)
  pushComment({ commentId: Number(lastInsertRowid), postId: post.id, author: me, content, replyUserId })
  return c.json({
    id: Number(lastInsertRowid), content, user_id: me.id, author: me.name,
    reply_to: replyToId, reply_author: replyAuthor, avatarUrl: me.avatarUrl,
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  })
})

// 删除评论:评论作者本人,或该动态的作者(在自己地盘可管理)
app.delete('/api/posts/:id/comments/:cid', requireAuth, async (c) => {
  const comment = db
    .prepare('SELECT c.id, c.post_id, c.user_id, c.created_at, p.user_id AS post_owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ? AND c.post_id = ?')
    .get(Number(c.req.param('cid')), Number(c.req.param('id')))
  if (!comment) return c.json({ error: '评论不存在' }, 404)
  const me = c.get('user')
  if (comment.user_id !== me.id && comment.post_owner !== me.id) {
    return c.json({ error: '只能删除自己的评论或自己动态下的评论' }, 403)
  }
  if (!withinEditWindow(comment)) return c.json({ error: '评论发布超过 24 小时,不能再删除' }, 403)
  // 被回复的评论删除后,其他评论回退为普通评论,不留下失效引用。
  db.prepare('UPDATE comments SET reply_to = NULL WHERE reply_to = ?').run(comment.id)
  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id)
  return c.json({ ok: true })
})

// ---------- 站内通知(对方新评论提醒) ----------
// 水位线方案:user_settings.comments_seen_id 记录已读的最大评论 id,
// 晚于它且非本人发表的评论即为未读;双人博客里对方的任何评论都值得提醒。

app.get('/api/notifications', requireAuth, (c) => {
  const me = c.get('user')
  const seenId = Number(getUserSetting(me.id, 'comments_seen_id', '0')) || 0
  const items = db
    .prepare(`
      SELECT c.id, c.post_id, c.content, c.created_at, u.name AS author,
             substr(p.content, 1, 60) AS post_excerpt,
             (reply.user_id = ?) AS reply_to_me
      FROM comments c
      JOIN users u ON u.id = c.user_id
      JOIN posts p ON p.id = c.post_id
      LEFT JOIN comments reply ON reply.id = c.reply_to
      WHERE c.id > ? AND c.user_id != ?
      ORDER BY c.id DESC LIMIT 20`)
    .all(me.id, seenId, me.id)
  return c.json({ items: items.map((it) => ({ ...it, reply_to_me: Boolean(it.reply_to_me) })) })
})

app.post('/api/notifications/read', requireAuth, (c) => {
  const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM comments').get().m
  setUserSetting(c.get('user').id, 'comments_seen_id', String(maxId))
  return c.json({ ok: true })
})

// ---------- 浏览器系统通知(Web Push) ----------
// 铃铛轮询只在页面活着时有效,关掉网页就收不到,所以系统通知一律走 Web Push:
// 浏览器把订阅交给服务端,评论落库后由服务端直接推给推送服务,与页面是否存在无关。

app.get('/api/push/key', requireAuth, (c) => c.json({ key: vapidPublicKey() }))

app.post('/api/push/subscribe', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) || {}
  const endpoint = String(body.endpoint ?? '')
  const p256dh = String(body.keys?.p256dh ?? '')
  const auth = String(body.keys?.auth ?? '')
  if (!isValidSubscription({ endpoint, p256dh, auth })) return c.json({ error: '订阅信息无效' }, 400)
  saveSubscription(c.get('user').id, { endpoint, p256dh, auth })
  return c.json({ ok: true })
})

app.post('/api/push/unsubscribe', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) || {}
  removeSubscription(c.get('user').id, String(body.endpoint ?? ''))
  return c.json({ ok: true })
})

// 新评论推给除发表者外的所有人,与 /api/notifications 的未读口径一致。
// 推送依赖外部服务,不能拖慢或拖垮评论接口,因此不 await、失败只在 push.js 里记日志。
function pushComment({ commentId, postId, author, content, replyUserId }) {
  const excerpt = content.length > 80 ? content.slice(0, 80) + '…' : content
  const title = `${author.name} · ${siteConfig().title}`
  for (const { id } of db.prepare('SELECT id FROM users WHERE id != ?').all(author.id)) {
    pushToUser(id, {
      title,
      body: `${id === replyUserId ? '回复了你' : '评论了'}: ${excerpt}`,
      tag: `comment-${commentId}`,
      postId,
      commentId,
    })
  }
}

// 表情点评:同一用户对同一动态的同一表情可切换开关。
const REACTION_EMOJIS = new Set('👍 ❤️ 😂 😍 🎉 😢 😡 👏 🔥 💯 🙌 🥰 😮 🤔'.split(' '))
app.post('/api/posts/:id/reactions', requireAuth, async (c) => {
  const [post, err] = postOr404(c)
  if (err) return err
  const emoji = String((await c.req.json().catch(() => ({}))).emoji ?? '')
  if (!REACTION_EMOJIS.has(emoji)) return c.json({ error: '不支持的表情' }, 400)
  const me = c.get('user')
  const existing = db.prepare('SELECT 1 FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?').get(post.id, me.id, emoji)
  if (existing) db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?').run(post.id, me.id, emoji)
  else db.prepare('INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(post.id, me.id, emoji)
  const rows = db.prepare('SELECT emoji, COUNT(*) AS count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reacted FROM post_reactions WHERE post_id = ? GROUP BY emoji ORDER BY emoji').all(me.id, post.id)
  return c.json({ reactions: rows.map((row) => ({ emoji: row.emoji, count: row.count, reacted: Boolean(row.reacted) })) })
})

// ---------- 相册 ----------

app.get('/api/gallery', requireViewer, (c) => {
  const rows = db
    .prepare(`
      SELECT i.id, i.filename, i.post_id, i.type, i.motion_filename, i.poster_filename, i.duration,
             p.created_at, u.name AS author
      FROM images i JOIN posts p ON p.id = i.post_id JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC, i.sort, i.id`)
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

// ---------- 图片存储(本地 / WebDAV) ----------

app.get('/api/storage', requireAuth, (c) => {
  const cfg = webdav.config()
  return c.json({
    backend: activeBackend(),
    counts: db.prepare('SELECT storage, COUNT(*) AS count FROM images GROUP BY storage').all(),
    webdav: {
      url: cfg.url,
      username: cfg.username,
      hasPassword: cfg.hasPassword,
      folder: cfg.folder,
      connected: webdav.isConnected(),
    },
  })
})

app.put('/api/storage', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const backend = body.backend === WEBDAV ? WEBDAV : LOCAL
  const url = String(body.url ?? '').trim()
  const username = String(body.username ?? '').trim()
  const folder = String(body.folder ?? '').trim() || 'images'
  // 密码留空表示沿用已保存的值(前端不回显密文)
  const password = String(body.password ?? '').trim()
  if (backend === WEBDAV) {
    if (!url || !username || !password && !webdav.config().hasPassword) {
      return c.json({ error: '切到 WebDAV 需填写完整的地址、用户名与密码' }, 400)
    }
    if (url && !/^https?:\/\/\S+\/$/.test(url)) {
      return c.json({ error: 'WebDAV 地址必须以 http:// 或 https:// 开头、以 / 结尾(完整根目录)' }, 400)
    }
  }
  setSetting('webdav_url', url)
  setSetting('webdav_username', username)
  if (password) setSetting('webdav_password', password)
  setSetting('webdav_folder', folder)
  setSetting('storage_backend', backend)
  return c.json({ ok: true })
})

// 测试 WebDAV 连通性:对根目录做一次 PROPFIND,验证凭据与可达性
app.post('/api/storage/webdav/test', requireAuth, async (c) => {
  // 先保存表单(密码留空沿用),再探测,避免测试的是旧凭据
  const body = await c.req.json().catch(() => ({}))
  setSetting('webdav_url', String(body.url ?? '').trim())
  setSetting('webdav_username', String(body.username ?? '').trim())
  if (String(body.password ?? '').trim()) setSetting('webdav_password', String(body.password).trim())
  setSetting('webdav_folder', String(body.folder ?? '').trim() || 'images')
  const r = await webdav.testConnection()
  return c.json(r, r.ok ? 200 : 400)
})

app.route('/api/llm', llmApp)
app.route('/api/image-jobs', imageJobsApp)

// ---------- 图片文件与静态资源 ----------

app.get('/avatars/:name', async (c) => {
  const name = c.req.param('name')
  if (!AVATAR_NAME_RE.test(name)) return c.text('Not Found', 404)
  const owner = db.prepare('SELECT 1 FROM users WHERE avatar_filename = ? LIMIT 1').get(name)
  if (!owner) return c.text('Not Found', 404)
  try {
    const buf = await readFile(path.join(AVATAR_DIR, name))
    return c.body(buf, 200, {
      'Content-Type': AVATAR_MIME_BY_EXT[path.extname(name)],
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
  } catch {
    return c.text('Not Found', 404)
  }
})

// 一个媒体项最多三个文件(主文件 / 实况配对视频 / 视频封面),三者共用同一套可见性与存储定位
function mediaRowFor(name) {
  return db.prepare(`SELECT i.*, p.public_images FROM images i JOIN posts p ON p.id = i.post_id
    WHERE i.filename = ? OR i.motion_filename = ? OR i.poster_filename = ? LIMIT 1`).get(name, name, name)
}

function fileStorage(row, name) {
  if (!row) return null
  if (row.filename === name) return row.storage_path || name
  if (row.motion_filename === name) return row.motion_path || name
  if (row.poster_filename === name) return row.poster_path || name
  return null
}

function fileBackend(row, name) {
  if (!row) return LOCAL
  if (row.filename === name) return row.storage
  if (row.motion_filename === name) return row.motion_storage || row.storage
  if (row.poster_filename === name) return row.poster_storage || row.storage
  return LOCAL
}

app.get('/uploads/:name', async (c) => {
  const name = c.req.param('name')
  if (!UPLOAD_NAME_RE.test(name)) return c.text('Not Found', 404)
  const row = mediaRowFor(name)
  // 私密模式下未登录访客:该文件所属文章的「公开图片」开关决定放行。
  // 实况配对视频与视频封面跟主文件同权,否则配对视频会被误判 401。
  if (siteConfig().privateMode && !c.get('user') && !row?.public_images) {
    return c.json({ error: '请先登录' }, 401)
  }
  // 还没发布、只在草稿里的文件从 pending 表取存储位置
  const pendingRow = row ? null : db.prepare('SELECT storage, storage_path FROM pending_uploads WHERE filename = ? LIMIT 1').get(name)
  const backend = row ? fileBackend(row, name) : (pendingRow?.storage || LOCAL)
  // 历史 onedrive 等已失效后端:代码移除后无法再读,按不存在处理
  if (backend !== LOCAL && backend !== WEBDAV) return c.text('Not Found', 404)
  const storagePath = row ? fileStorage(row, name) : (pendingRow?.storage_path || name)
  const contentType = MIME_BY_EXT[path.extname(name).toLowerCase()]
  if (!contentType) return c.text('Not Found', 404)

  if (!isVideoName(name)) {
    try {
      const buf = await getImage(name, backend, storagePath)
      return c.body(buf, 200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=31536000, immutable' })
    } catch (e) {
      // 本地缺文件就是 404;WebDAV 取不到多半是临时故障,不能当成文件不存在
      if (backend === LOCAL) return c.text('Not Found', 404)
      console.warn(`读取 WebDAV 图片 ${name} 失败: ${e.message}`)
      return c.text('Bad Gateway', 502)
    }
  }

  // 视频走流式 + Range:浏览器要 206 才能拖动进度条,Safari 更要求 Accept-Ranges
  try {
    const opened = await openStream(name, backend, storagePath, c.req.header('range'))
    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
    }
    const partial = opened.start > 0 || opened.end == null || opened.total == null || opened.end < opened.total - 1
    if (partial && opened.total != null && opened.end != null) {
      headers['Content-Range'] = `bytes ${opened.start}-${opened.end}/${opened.total}`
      headers['Content-Length'] = String(opened.end - opened.start + 1)
      return c.body(opened.stream, 206, headers)
    }
    if (opened.total != null) headers['Content-Length'] = String(opened.total)
    return c.body(opened.stream, 200, headers)
  } catch (e) {
    if (backend === LOCAL) return c.text('Not Found', 404)
    console.warn(`读取 WebDAV 视频 ${name} 失败: ${e.message}`)
    return c.text('Bad Gateway', 502)
  }
})

// PWA 的应用名取自 manifest 的 name(优先级高于 <title>),静态文件跟不上后台改的站点名称,
// 所以按请求渲染:图标等字段仍只有 public/manifest.webmanifest 一份来源,这里只覆盖名称。
const MANIFEST = JSON.parse(readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'))
app.get('/manifest.webmanifest', (c) => {
  const { title } = siteConfig()
  return c.body(JSON.stringify({ ...MANIFEST, name: title, short_name: title }), 200, {
    'Content-Type': 'application/manifest+json',
    'Cache-Control': 'no-cache',
  })
})

app.use('*', serveStatic({ root: './public' }))

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`${siteConfig().title} 已启动: http://localhost:${PORT}`)
  })
}
