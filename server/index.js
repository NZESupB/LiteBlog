import { serve } from '@hono/node-server'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createApp } from './app.js'
import { initializeRuntime, stopRuntime } from './bootstrap.js'
import { configValue, PROJECT_ROOT } from './config.js'
import { siteConfig } from './services/site.js'

// 兼容现有进程内 API 测试；纯路由构造请导入 app.js。
await initializeRuntime()
export const app = createApp({ staticRoot: path.resolve(PROJECT_ROOT, String(configValue('server.staticDir', 'dist'))) })

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await initializeRuntime({ schedule: true })
  const port = Number(configValue('server.port', 3000)) || 3000
  const server = serve({ fetch: app.fetch, port }, () => console.log(`${siteConfig().title} 已启动: http://localhost:${port}`))
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    const closed = new Promise((resolve) => server.close(resolve))
    try {
      await closed
      await stopRuntime()
    } catch (error) {
      console.error(`服务停止失败：${error.message}`)
      process.exitCode = 1
    }
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
