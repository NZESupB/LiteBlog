import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { PROJECT_ROOT, setConfigForTests } from '../server/config.js'
const dataDir = path.join(PROJECT_ROOT, 'data', `runtime-regression-${process.pid}`)
assert.equal(existsSync(dataDir), false)
setConfigForTests({
  server: { dataDir },
  security: { jwtSecret: 'isolated-runtime-test' },
  storage: { backend: 'local' },
  media: { ffmpegPath: '/nonexistent-ffmpeg', ffprobePath: '/nonexistent-ffprobe' },
})
const { createApp } = await import('../server/app.js')
const app = createApp()
assert.equal(existsSync(dataDir), false, '导入应用工厂和构建路由不得创建数据库或目录')
const { initializeRuntime, stopRuntime } = await import('../server/bootstrap.js')
const { getDatabase } = await import('../server/db.js')
try {
  await Promise.all([initializeRuntime(), initializeRuntime()])
  const first = getDatabase()
  assert.equal(first.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2)
  assert.equal((await app.request('/api/site')).status, 200)
  const login = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'user1', password: 'pass1' }),
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const config = await (
    await app.request('/api/uploads/video/config', { headers: { Cookie: cookie } })
  ).json()
  assert.equal(config.available, false, '工具缺失仍允许图文服务启动')
  await stopRuntime()
  assert.equal(first.isOpen, false)
  await initializeRuntime()
  assert.notEqual(getDatabase(), first, '重启不能缓存旧连接')
  assert.equal((await app.request('/api/site')).status, 200)
  console.log('通过：工厂无落盘副作用、并发初始化、FFmpeg 缺失、停止排空和连接重建。')
} finally {
  await stopRuntime()
  rmSync(dataDir, { recursive: true, force: true })
}
