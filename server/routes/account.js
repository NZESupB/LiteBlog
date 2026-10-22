import { createHash } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { db, AVATAR_DIR, hashPassword, verifyPassword } from '../db.js'
import { createSession, clearSession, requireAuth } from '../auth.js'
import { avatarUrl } from '../services/site.js'

export function registerAccount(app) {
  app.post('/api/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {}
    const username = String(body.username ?? body.name ?? '').trim()
    const user = username && db.prepare('SELECT * FROM users WHERE username = ?').get(username)
    if (!user || !verifyPassword(String(body.password || ''), user.pass_hash))
      return c.json({ error: '登录账号或密码错误' }, 401)
    await createSession(c, user)
    return c.json({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        displayName: user.name,
        avatarUrl: avatarUrl(user.avatar_filename),
      },
    })
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
    const legacy =
      !Object.hasOwn(body, 'username') && !Object.hasOwn(body, 'displayName') && Object.hasOwn(body, 'name')
    const username = String(
      (Object.hasOwn(body, 'username') ? body.username : legacy ? body.name : current.username) ?? '',
    ).trim()
    const name = String(
      (Object.hasOwn(body, 'displayName') ? body.displayName : body.name) ?? current.name,
    ).trim()
    if (!username || username.length > 24 || username.includes(':'))
      return c.json({ error: '登录账号需为 1-24 个字符,且不能包含冒号' }, 400)
    if (!name || name.length > 24) return c.json({ error: '显示名称需为 1-24 个字符' }, 400)
    if (db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, me.id))
      return c.json({ error: '登录账号已被占用' }, 400)
    if (db.prepare('SELECT id FROM users WHERE name = ? AND id != ?').get(name, me.id))
      return c.json({ error: '显示名称已被占用' }, 400)
    try {
      db.prepare('UPDATE users SET username = ?, name = ? WHERE id = ?').run(username, name, me.id)
    } catch (error) {
      if (error.code?.includes('SQLITE_CONSTRAINT') || [19, 2067].includes(error.errcode))
        return c.json({ error: '登录账号或显示名称已被占用' }, 400)
      throw error
    }
    await createSession(c, { id: me.id, username, name })
    const avatar = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(me.id)
    return c.json({
      ok: true,
      username,
      name,
      displayName: name,
      avatarUrl: avatarUrl(avatar?.avatar_filename),
    })
  })
  app.post('/api/profile/avatar', requireAuth, async (c) => {
    const file = (await c.req.formData().catch(() => null))?.get('avatar')
    if (!file || typeof file !== 'object' || !file.size) return c.json({ error: '没有收到头像图片' }, 400)
    if (file.size > 10 * 1024 * 1024) return c.json({ error: '头像不能超过 10MB' }, 400)
    const buf = Buffer.from(await file.arrayBuffer())
    const ext = detectAvatarType(buf)
    if (!ext) return c.json({ error: '头像仅支持 JPEG、PNG 或 WebP' }, 400)
    const me = c.get('user')
    const filename = `avatar-${me.id}-${Date.now()}-${createHash('sha256').update(buf).digest('hex').slice(0, 12)}${ext}`
    const target = path.join(AVATAR_DIR, filename)
    await writeFile(target, buf)
    const current = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(me.id)
    try {
      db.prepare('UPDATE users SET avatar_filename = ? WHERE id = ?').run(filename, me.id)
    } catch (error) {
      await unlink(target).catch(() => {})
      throw error
    }
    if (current?.avatar_filename) await unlink(path.join(AVATAR_DIR, current.avatar_filename)).catch(() => {})
    return c.json({ ok: true, avatarUrl: avatarUrl(filename) })
  })
  app.delete('/api/profile/avatar', requireAuth, async (c) => {
    const current = db.prepare('SELECT avatar_filename FROM users WHERE id = ?').get(c.get('user').id)
    db.prepare('UPDATE users SET avatar_filename = NULL WHERE id = ?').run(c.get('user').id)
    if (current?.avatar_filename) await unlink(path.join(AVATAR_DIR, current.avatar_filename)).catch(() => {})
    return c.json({ ok: true, avatarUrl: null })
  })
  app.post('/api/password', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(c.get('user').id)
    if (!verifyPassword(String(body.oldPassword || ''), user.pass_hash))
      return c.json({ error: '原密码错误' }, 400)
    if (String(body.newPassword || '').length < 6) return c.json({ error: '新密码至少 6 位' }, 400)
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(
      hashPassword(String(body.newPassword)),
      user.id,
    )
    return c.json({ ok: true })
  })
}
function detectAvatarType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return '.png'
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return '.webp'
  return null
}
