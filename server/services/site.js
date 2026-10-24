import path from 'node:path'
import { db, getSetting } from '../db.js'
import { configValue } from '../config.js'

export const REACTION_EMOJIS = new Set('👍 ❤️ 😂 😍 🎉 😢 😡 👏 🔥 💯 🙌 🥰 😮 🤔'.split(' '))
export const IMAGE_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
}
export const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}
export const UPLOAD_NAME_RE =
  /^(?:[a-f0-9]{16}|\d{8}-\d{6}-[a-f0-9]{8}(?:-[a-zA-Z0-9-]+)?|ai-[a-zA-Z0-9-]+)\.(jpg|png|webp|gif|mp4|mov|webm)$/
export const AVATAR_NAME_RE = /^avatar-\d+-\d+-[a-f0-9]{12}\.(jpg|png|webp)$/
export const AVATAR_MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
export const isVideoName = (name) =>
  ['.mp4', '.mov', '.webm'].includes(path.extname(String(name)).toLowerCase())
export const avatarUrl = (filename) => (filename ? `/avatars/${filename}` : null)

export function siteConfig() {
  return {
    title: getSetting('title', String(configValue('site.title', '我们的日常'))),
    anniversary: getSetting('anniversary', String(configValue('site.anniversary', ''))),
    privateMode:
      getSetting('private_mode', String(configValue('site.privateMode', false)).toLowerCase()) === 'true',
  }
}
export async function requireViewer(c, next) {
  if (siteConfig().privateMode && !c.get('user')) return c.json({ error: '请先登录' }, 401)
  await next()
}
export function attachAvatars(rows) {
  for (const row of rows) {
    row.avatarUrl = avatarUrl(row.avatar_filename)
    delete row.avatar_filename
    if (Object.hasOwn(row, 'reply_avatar_filename')) {
      row.replyAvatarUrl = avatarUrl(row.reply_avatar_filename)
      delete row.reply_avatar_filename
    }
  }
  return rows
}
export function withinEditWindow(record) {
  return Date.now() - new Date(record.created_at.replace(' ', 'T') + 'Z').getTime() <= 86400000
}
export function postOr404(c) {
  const post = db
    .prepare('SELECT id, user_id, public_text FROM posts WHERE id = ?')
    .get(Number(c.req.param('id')))
  return post ? [post, null] : [null, c.json({ error: '动态不存在' }, 404)]
}
export function mediaPayload(row) {
  const media = {
    id: row.id,
    type: row.type === 'video' ? 'video' : 'image',
    url: `/uploads/${row.filename}`,
  }
  if (media.type === 'video') {
    if (row.poster_filename) media.poster = `/uploads/${row.poster_filename}`
    if (row.duration != null) media.duration = row.duration
  } else if (row.motion_filename) {
    media.live = true
    media.motion = `/uploads/${row.motion_filename}`
  }
  return media
}
