import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { backup } from 'node:sqlite'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { setConfigForTests, PROJECT_ROOT } from '../../server/config.js'
mkdirSync(path.join(PROJECT_ROOT, 'data'), { recursive: true })
const dataDir = mkdtempSync(path.join(PROJECT_ROOT, 'data', 'react-e2e-'))
setConfigForTests({
  server: { dataDir },
  security: { jwtSecret: 'isolated-react-e2e' },
  storage: { backend: 'local' },
  site: { title: '迁移测试手记', privateMode: true },
  media: { videoEncoder: 'libx265', videoThreads: 2 },
})
const { initializeRuntime, stopRuntime } = await import('../../server/bootstrap.js')
const { createApp } = await import('../../server/app.js')
const { getDatabase } = await import('../../server/db.js')
await initializeRuntime()
const app = new Hono()
// 只在隔离测试进程提供故障注入与快照接口，不进入生产应用。
let swVersion = 'current'
app.post('/__test/sw', async (c) => {
  swVersion = (await c.req.json()).version
  return c.json({ ok: true })
})
app.get('/__test/legacy', (c) => c.html('<h1>旧版测试页</h1>'))
app.get('/app.js', (c) =>
  swVersion === 'legacy'
    ? c.body('export const legacy = true', 200, { 'Content-Type': 'text/javascript' })
    : c.notFound(),
)
app.get('/js/legacy.js', (c) =>
  swVersion === 'legacy'
    ? c.body('export const legacyModule = true', 200, { 'Content-Type': 'text/javascript' })
    : c.notFound(),
)
app.get('/sw.js', (c) => {
  let source = readFileSync(path.join(PROJECT_ROOT, 'dist/sw.js'), 'utf8')
  if (swVersion === 'legacy')
    source = `
    const CACHE = 'couple-blog-shell-v21';
    self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/index.html', '/style.css', '/app.js', '/js/legacy.js'])).then(() => self.skipWaiting())));
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => { if (e.request.method === 'GET' && new URL(e.request.url).origin === self.location.origin && !new URL(e.request.url).pathname.startsWith('/api/')) e.respondWith(fetch(e.request).then(async r => r.ok ? r : await caches.match(e.request) || r).catch(() => caches.match(e.request))); });
  `
  if (swVersion === 'next')
    source = source.replace(/couple-blog-shell-([a-f0-9]{16})/, 'couple-blog-shell-next-$1')
  if (swVersion === 'broken')
    source = source.replace('const SHELL = [', 'const SHELL = ["/__test/not-found",')
  return c.body(source, 200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
})
app.get('/__test/video', (c) => {
  const filename = path.join(dataDir, 'fixture.mp4')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=pink:s=320x240:r=24',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    filename,
  ])
  return c.body(readFileSync(filename), 200, { 'Content-Type': 'video/mp4' })
})
app.get('/__test/playable.webm', (c) => {
  const filename = path.join(dataDir, 'playable.webm')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=pink:s=320x240:r=24',
    '-t',
    '3',
    '-c:v',
    'libvpx',
    '-deadline',
    'realtime',
    '-pix_fmt',
    'yuv420p',
    filename,
  ])
  return c.body(readFileSync(filename), 200, { 'Content-Type': 'video/webm' })
})
app.get('/__test/snapshot', async (c) => {
  const filename = path.join(dataDir, 'fixture.db')
  await backup(getDatabase(), filename)
  return c.body(readFileSync(filename), 200, { 'Content-Type': 'application/octet-stream' })
})
app.route('/', createApp())
const server = serve({ fetch: app.fetch, port: 4317, hostname: '127.0.0.1' }, () =>
  console.log('隔离 React 测试服务已就绪'),
)
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await new Promise((resolve) => server.close(resolve))
  try {
    await stopRuntime()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
