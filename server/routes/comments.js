import { db, getUserSetting, setUserSetting } from '../db.js'
import { requireAuth } from '../auth.js'
import {
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  pushToUser,
  isValidSubscription,
} from '../push.js'
import { siteConfig, attachAvatars, postOr404, withinEditWindow } from '../services/site.js'

export function registerComments(app) {
  app.get('/api/posts/:id/comments', (c) => {
    const [post, error] = postOr404(c)
    if (error) return error
    if (siteConfig().privateMode && !c.get('user') && !post.public_text)
      return c.json({ error: '请先登录' }, 401)
    const rows = db
      .prepare(
        `SELECT c.id, c.content, c.created_at, c.user_id, c.reply_to, u.name AS author, u.avatar_filename,
      reply_user.name AS reply_author, reply_user.avatar_filename AS reply_avatar_filename, reply.content AS reply_content
      FROM comments c JOIN users u ON u.id = c.user_id
      LEFT JOIN comments reply ON reply.id = c.reply_to AND reply.post_id = c.post_id
      LEFT JOIN users reply_user ON reply_user.id = reply.user_id WHERE c.post_id = ? ORDER BY c.id ASC`,
      )
      .all(post.id)
    return c.json({ comments: attachAvatars(rows) })
  })
  app.post('/api/posts/:id/comments', requireAuth, async (c) => {
    const [post, error] = postOr404(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({})),
      content = String(body.content ?? '').trim()
    if (!content) return c.json({ error: '评论不能为空' }, 400)
    if (content.length > 500) return c.json({ error: '评论不超过 500 字' }, 400)
    const replyToId = body.replyToId == null || body.replyToId === '' ? null : Number(body.replyToId)
    if (replyToId !== null && (!Number.isSafeInteger(replyToId) || replyToId < 1))
      return c.json({ error: '回复目标无效' }, 400)
    let replyAuthor = null,
      replyUserId = null
    if (replyToId !== null) {
      const reply = db
        .prepare(
          'SELECT c.id, c.user_id, u.name AS author FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.post_id = ?',
        )
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
      id: Number(lastInsertRowid),
      content,
      user_id: me.id,
      author: me.name,
      reply_to: replyToId,
      reply_author: replyAuthor,
      avatarUrl: me.avatarUrl,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    })
  })
  app.delete('/api/posts/:id/comments/:cid', requireAuth, (c) => {
    const comment = db
      .prepare(
        'SELECT c.id, c.post_id, c.user_id, c.created_at, p.user_id AS post_owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ? AND c.post_id = ?',
      )
      .get(Number(c.req.param('cid')), Number(c.req.param('id')))
    if (!comment) return c.json({ error: '评论不存在' }, 404)
    const me = c.get('user')
    if (comment.user_id !== me.id && comment.post_owner !== me.id)
      return c.json({ error: '只能删除自己的评论或自己动态下的评论' }, 403)
    if (!withinEditWindow(comment)) return c.json({ error: '评论发布超过 24 小时,不能再删除' }, 403)
    db.prepare('UPDATE comments SET reply_to = NULL WHERE reply_to = ?').run(comment.id)
    db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id)
    return c.json({ ok: true })
  })
  app.get('/api/notifications', requireAuth, (c) => {
    const me = c.get('user'),
      seenId = Number(getUserSetting(me.id, 'comments_seen_id', '0')) || 0
    const items = db
      .prepare(
        `SELECT c.id, c.post_id, c.content, c.created_at, u.name AS author, substr(p.content, 1, 60) AS post_excerpt,
      (reply.user_id = ?) AS reply_to_me FROM comments c JOIN users u ON u.id = c.user_id JOIN posts p ON p.id = c.post_id
      LEFT JOIN comments reply ON reply.id = c.reply_to WHERE c.id > ? AND c.user_id != ? ORDER BY c.id DESC LIMIT 20`,
      )
      .all(me.id, seenId, me.id)
    return c.json({ items: items.map((item) => ({ ...item, reply_to_me: Boolean(item.reply_to_me) })) })
  })
  app.post('/api/notifications/read', requireAuth, (c) => {
    setUserSetting(
      c.get('user').id,
      'comments_seen_id',
      String(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM comments').get().m),
    )
    return c.json({ ok: true })
  })
  app.get('/api/push/key', requireAuth, (c) => c.json({ key: vapidPublicKey() }))
  app.post('/api/push/subscribe', requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {}
    const subscription = {
      endpoint: String(body.endpoint ?? ''),
      p256dh: String(body.keys?.p256dh ?? ''),
      auth: String(body.keys?.auth ?? ''),
    }
    if (!isValidSubscription(subscription)) return c.json({ error: '订阅信息无效' }, 400)
    saveSubscription(c.get('user').id, subscription)
    return c.json({ ok: true })
  })
  app.post('/api/push/unsubscribe', requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {}
    removeSubscription(c.get('user').id, String(body.endpoint ?? ''))
    return c.json({ ok: true })
  })
}
function pushComment({ commentId, postId, author, content, replyUserId }) {
  const excerpt = content.length > 80 ? content.slice(0, 80) + '…' : content
  for (const { id } of db.prepare('SELECT id FROM users WHERE id != ?').all(author.id)) {
    pushToUser(id, {
      title: `${author.name} · ${siteConfig().title}`,
      body: `${id === replyUserId ? '回复了你' : '评论了'}: ${excerpt}`,
      tag: `comment-${commentId}`,
      postId,
      commentId,
    })
  }
}
