import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { PROJECT_ROOT } from './config.js'
import { sessionMiddleware } from './auth.js'
import { maintenanceMiddleware } from './maintenance.js'
import { backupsApp } from './backup.js'
import { llmApp } from './llm.js'
import { imageJobsApp } from './image-jobs.js'
import { registerSettings } from './routes/settings.js'
import { registerAccount } from './routes/account.js'
import { registerPosts } from './routes/posts.js'
import { registerComments } from './routes/comments.js'
import { registerUploads } from './routes/uploads.js'
import { registerMedia } from './routes/media.js'
import { siteConfig } from './services/site.js'

// 构造路由不打开数据库、不启动监听或后台任务。
export function createApp({ staticRoot = path.join(PROJECT_ROOT, 'dist') } = {}) {
  const app = new Hono()
  app.use('*', maintenanceMiddleware)
  app.use('*', sessionMiddleware)
  app.route('/api/backups', backupsApp)
  registerSettings(app)
  registerAccount(app)
  registerPosts(app)
  registerComments(app)
  registerUploads(app)
  registerMedia(app)
  app.route('/api/llm', llmApp)
  app.route('/api/image-jobs', imageJobsApp)
  app.get('/manifest.webmanifest', (c) => {
    const manifest = JSON.parse(readFileSync(path.join(staticRoot, 'manifest.webmanifest'), 'utf8'))
    const { title } = siteConfig()
    return c.body(JSON.stringify({ ...manifest, name: title, short_name: title }), 200, {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-cache',
    })
  })
  app.use('*', async (c, next) => {
    if (['/', '/index.html', '/sw.js'].includes(c.req.path)) c.header('Cache-Control', 'no-cache')
    else if (c.req.path.startsWith('/assets/'))
      c.header('Cache-Control', 'public, max-age=31536000, immutable')
    await next()
  })
  app.use('*', serveStatic({ root: staticRoot }))
  return app
}
