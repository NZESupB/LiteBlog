import { db } from '../db.js'
import { requireAuth } from '../auth.js'
import { draftOwnedBy, cleanupDraftUploads } from '../image-jobs.js'
import { assertVideoUploadSelected, cleanupPublishedVideoVersions } from '../video-jobs.js'
import { deleteImage } from '../storage.js'
import { enterOperation } from '../maintenance.js'
import {
  siteConfig,
  attachAvatars,
  mediaPayload,
  postOr404,
  REACTION_EMOJIS,
  UPLOAD_NAME_RE,
  isVideoName,
} from '../services/site.js'
import { isReferenced, mediaFiles } from '../services/media.js'

export function registerPosts(app) {
  function attachImages(posts) {
    if (posts.length === 0) return posts
    const ids = posts.map((p) => p.id)
    const rows = db
      .prepare(
        `SELECT id, post_id, filename, type, motion_filename, poster_filename, duration FROM images WHERE post_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, id`,
      )
      .all(...ids)
    const byPost = new Map(posts.map((p) => [p.id, (p.images = [])]))
    for (const r of rows) byPost.get(r.post_id).push(mediaPayload(r))
    return posts
  }

  function attachReactions(posts, userId = null) {
    if (posts.length === 0) return posts
    const ids = posts.map((p) => p.id)
    const rows = db
      .prepare(
        `
    SELECT post_id, emoji, COUNT(*) AS count,
      SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reacted
    FROM post_reactions
    WHERE post_id IN (${ids.map(() => '?').join(',')})
    GROUP BY post_id, emoji
    ORDER BY post_id, emoji`,
      )
      .all(userId || 0, ...ids)
    const byPost = new Map(posts.map((p) => [p.id, (p.reactions = [])]))
    for (const row of rows)
      byPost.get(row.post_id).push({ emoji: row.emoji, count: row.count, reacted: Boolean(row.reacted) })
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
      .prepare(
        `
      SELECT p.id, p.content, p.created_at, p.updated_at, p.user_id, p.public_text, p.public_images, u.name AS author, u.avatar_filename
      FROM posts p JOIN users u ON u.id = p.user_id
      ${cursor ? 'WHERE (p.created_at, p.id) < (?, ?)' : ''}
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
      )
      .all(...(cursor ? [cursor.at, cursor.id] : []), limit + 1)
    const hasMore = rows.length > limit
    const posts = hasMore ? rows.slice(0, limit) : rows
    const last = posts[posts.length - 1]
    const nextCursor = hasMore && last ? `${last.created_at}|${last.id}` : null

    const withImages = withCanEdit(
      attachAvatars(attachReactions(attachImages(posts), c.get('user')?.id)),
      c.get('user'),
    )
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
      .prepare(
        `
      SELECT strftime('%Y-%m', created_at, ?) AS month, COUNT(*) AS count
      FROM posts GROUP BY month ORDER BY month DESC`,
      )
      .all(`${tz} minutes`)
    return c.json({ months, total: months.reduce((sum, row) => sum + row.count, 0) })
  })

  // 单条动态(站内通知跳转的落地页),访客可见性规则与列表一致
  app.get('/api/posts/:id', (c) => {
    const post = db
      .prepare(
        `
      SELECT p.id, p.content, p.created_at, p.updated_at, p.user_id, p.public_text, p.public_images, u.name AS author, u.avatar_filename
      FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
      )
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

  function lookupUploadable(name, userId, draftId = null) {
    if (!UPLOAD_NAME_RE.test(name)) throw new Error('媒体参数不合法')
    name = assertVideoUploadSelected(userId, name)
    const row =
      (draftId
        ? db
            .prepare(
              'SELECT filename, hash, storage, storage_path FROM pending_uploads WHERE filename = ? AND user_id = ? AND draft_id = ?',
            )
            .get(name, userId, draftId)
        : db
            .prepare(
              'SELECT filename, hash, storage, storage_path FROM pending_uploads WHERE filename = ? AND user_id = ? AND draft_id IS NULL',
            )
            .get(name, userId)) ||
      db
        .prepare(
          `SELECT i.filename, i.hash, i.storage, i.storage_path
      FROM images i JOIN posts p ON p.id = i.post_id
      WHERE i.filename = ? AND p.user_id = ? LIMIT 1`,
        )
        .get(name, userId)
    if (!row) throw new Error('媒体不存在或已过期,请重新上传')
    return row
  }

  // 把前端提交的媒体项换成可写入 images 的记录。元素既接受旧的纯文件名字符串,
  // 也接受 { filename, motion, poster, duration } —— motion 是实况配对视频,poster 是视频封面。
  function claimUploads(items, userId, draftId = null) {
    return items.map((raw) => {
      const item = typeof raw === 'string' ? { filename: raw } : raw && typeof raw === 'object' ? raw : {}
      const filename = String(item.filename || '')
      const base = lookupUploadable(filename, userId, draftId)
      const motionName = String(item.motion || '')
      const posterName = String(item.poster || '')
      if (motionName && !isVideoName(motionName)) throw new Error('实况配对文件必须是视频')
      if (motionName && isVideoName(filename)) throw new Error('实况封面必须是图片')
      if (motionName && posterName) throw new Error('实况图片不能另挂视频封面')
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
        postId,
        media.filename,
        startSort + i,
        media.storage,
        media.hash,
        media.storage_path || media.filename,
        isVideoName(media.filename) ? 'video' : 'image',
        motion?.filename ?? null,
        motion?.storage ?? null,
        motion ? motion.storage_path || motion.filename : null,
        poster?.filename ?? null,
        poster?.storage ?? null,
        poster ? poster.storage_path || poster.filename : null,
        media.duration ?? null,
      )
      for (const name of [media.filename, motion?.filename, poster?.filename]) if (name) dropPending.run(name)
    })
  }

  // 动态被删/改时移除其全部媒体文件(主文件 + 实况配对视频 + 视频封面):没有任何其他引用才真删
  async function removeMediaFiles(row) {
    for (const file of mediaFiles(row)) {
      if (isReferenced(file.filename)) continue
      await deleteImage(file.filename, file.storage, file.path).catch((e) =>
        console.warn(`删除文件 ${file.filename} 失败: ${e.message}`),
      )
    }
  }
  function schedulePostCleanup(userId, claimed, draftId, removed = []) {
    const release = enterOperation('media')
    // 请求只等待发布事务；网络存储清理在受维护生命周期保护的后台执行。
    void Promise.resolve().then(async () => {
      for (const image of removed) await removeMediaFiles(image)
      await cleanupPublishedVideoVersions(userId, claimed.flatMap((media) => [media.filename, media.motion?.filename].filter(Boolean)))
      if (draftId) await cleanupDraftUploads(userId, draftId)
    }).catch((error) => console.warn(`发布后媒体清理失败：${error.message}`)).finally(release)
  }

  app.post('/api/posts', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const content = String(body.content || '').trim()
    const names = Array.isArray(body.images) ? body.images : []
    const draftId = String(body.draftId ?? '').trim() || null
    if (draftId && !draftOwnedBy(c.get('user').id, draftId))
      return c.json({ error: '草稿不存在或无权操作' }, 403)
    if (draftId) {
      const draft = db
        .prepare('SELECT post_id, status FROM drafts WHERE id = ? AND user_id = ?')
        .get(draftId, c.get('user').id)
      if (draft?.status === 'published' && draft.post_id)
        return c.json({ id: Number(draft.post_id), reused: true })
    }
    if (!content && names.length === 0) return c.json({ error: '写点什么或传张图吧' }, 400)

    let claimed
    try {
      claimed = claimUploads(names, c.get('user').id, draftId)
    } catch (e) {
      return c.json({ error: e.message }, e.status || 400)
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
      if (draftId)
        db.prepare(
          "UPDATE drafts SET status = 'published', post_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
        ).run(Number(postId), draftId, c.get('user').id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    schedulePostCleanup(c.get('user').id, claimed, draftId)
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
    if (draftId && !draftOwnedBy(c.get('user').id, draftId))
      return c.json({ error: '草稿不存在或无权操作' }, 403)
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
      return c.json({ error: e.message }, e.status || 400)
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
      db.prepare(
        "UPDATE posts SET content = ?, public_text = ?, public_images = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(content, publicText, publicImages, post.id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    schedulePostCleanup(c.get('user').id, claimed, draftId, removed)
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
  app.post('/api/posts/:id/reactions', requireAuth, async (c) => {
    const [post, err] = postOr404(c)
    if (err) return err
    const emoji = String((await c.req.json().catch(() => ({}))).emoji ?? '')
    if (!REACTION_EMOJIS.has(emoji)) return c.json({ error: '不支持的表情' }, 400)
    const me = c.get('user')
    const existing = db
      .prepare('SELECT 1 FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?')
      .get(post.id, me.id, emoji)
    if (existing)
      db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?').run(
        post.id,
        me.id,
        emoji,
      )
    else
      db.prepare('INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(
        post.id,
        me.id,
        emoji,
      )
    const rows = db
      .prepare(
        'SELECT emoji, COUNT(*) AS count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reacted FROM post_reactions WHERE post_id = ? GROUP BY emoji ORDER BY emoji',
      )
      .all(me.id, post.id)
    return c.json({
      reactions: rows.map((row) => ({ emoji: row.emoji, count: row.count, reacted: Boolean(row.reacted) })),
    })
  })
}
