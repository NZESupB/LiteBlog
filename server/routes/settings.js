import { Hono } from 'hono'
import { db, setSetting } from '../db.js'
import { requireAuth } from '../auth.js'
import { siteConfig, REACTION_EMOJIS } from '../services/site.js'
import { LOCAL, WEBDAV, activeBackend } from '../storage.js'
import * as webdav from '../webdav.js'

export function registerSettings(app) {
  app.get('/api/site', (c) =>
    c.json({ ...siteConfig(), user: c.get('user'), reactionEmojis: [...REACTION_EMOJIS] }),
  )
  app.put('/api/settings', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const title = String(body.title ?? '').trim()
    const anniversary = String(body.anniversary ?? '').trim()
    if (!title) return c.json({ error: '站点名不能为空' }, 400)
    if (anniversary && !/^\d{4}-\d{2}-\d{2}$/.test(anniversary))
      return c.json({ error: '纪念日格式应为 YYYY-MM-DD' }, 400)
    setSetting('title', title)
    setSetting('anniversary', anniversary)
    setSetting('private_mode', body.privateMode === true || body.privateMode === 'true' ? 'true' : 'false')
    return c.json({ ok: true, ...siteConfig() })
  })
  const storage = new Hono()
  storage.use('*', requireAuth)
  storage.get('/', (c) => {
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
  storage.put('/', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const backend = body.backend === WEBDAV ? WEBDAV : LOCAL
    const url = String(body.url ?? '').trim()
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '').trim()
    if (backend === WEBDAV) {
      if (!url || !username || (!password && !webdav.config().hasPassword))
        return c.json({ error: '切到 WebDAV 需填写完整的地址、用户名与密码' }, 400)
      if (!/^https?:\/\/\S+\/$/.test(url))
        return c.json({ error: 'WebDAV 地址必须以 http:// 或 https:// 开头、以 / 结尾(完整根目录)' }, 400)
    }
    saveWebdav(body)
    setSetting('storage_backend', backend)
    return c.json({ ok: true })
  })
  storage.post('/webdav/test', async (c) => {
    saveWebdav(await c.req.json().catch(() => ({})))
    const result = await webdav.testConnection()
    return c.json(result, result.ok ? 200 : 400)
  })
  app.route('/api/storage', storage)
}
function saveWebdav(body) {
  setSetting('webdav_url', String(body.url ?? '').trim())
  setSetting('webdav_username', String(body.username ?? '').trim())
  if (String(body.password ?? '').trim()) setSetting('webdav_password', String(body.password).trim())
  setSetting('webdav_folder', String(body.folder ?? '').trim() || 'images')
}
