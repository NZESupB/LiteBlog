// 使用内置断言验证改版涉及的页面资源与图文流程,不引入测试依赖。
// 执行: node tests/design-regression.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(path.join(root, 'data'), { recursive: true })
const dataDir = mkdtempSync(path.join(root, 'data', 'design-regression-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'isolated-design-regression'
process.env.PRIVATE_MODE = 'true'
process.env.STORAGE_BACKEND = 'local'

let db
try {
  const { app } = await import('../server/index.js')
  ;({ db } = await import('../server/db.js'))
  let cookie = ''
  async function request(url, { method = 'GET', body, authenticated = true } = {}) {
    const headers = new Headers()
    if (cookie && authenticated) headers.set('Cookie', cookie)
    if (body && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(body)
    }
    return app.request(url, { method, headers, body })
  }
  const login = await request('/api/login', { method: 'POST', body: { username: 'user1', password: 'pass1' } })
  assert.equal(login.status, 200)
  cookie = login.headers.get('set-cookie').split(';')[0]

  const form = new FormData()
  form.append('image', new Blob([readFileSync(path.join(root, 'public/images/journal-cover.jpg'))], { type: 'image/jpeg' }), 'cover.jpg')
  const uploaded = await request('/api/uploads', { method: 'POST', body: form })
  assert.equal(uploaded.status, 200)
  const upload = await uploaded.json()
  const published = await request('/api/posts', { method: 'POST', body: { content: '改版回归：一起记录今天。', images: [upload.filename] } })
  assert.ok(published.ok)
  const { id } = await published.json()
  const { posts } = await (await request('/api/posts')).json()
  assert.equal(posts[0].id, id)
  assert.equal(posts[0].content, '改版回归：一起记录今天。')
  assert.equal(posts[0].images.length, 1)
  const gallery = await (await request('/api/gallery')).json()
  assert.equal(gallery.images.length, 1)
  assert.equal((await request(gallery.images[0].url)).status, 200)
  assert.equal((await (await request('/api/posts/archive?tz=-480')).json()).total, 1)

  const guestPosts = await (await request('/api/posts', { authenticated: false })).json()
  assert.equal(guestPosts.posts[0].content, '')
  assert.equal(guestPosts.posts[0].images.length, 0)
  assert.equal((await request('/api/gallery', { authenticated: false })).status, 401)
  assert.equal((await request(upload.url, { authenticated: false })).status, 401)
  for (const resource of ['/', '/style.css', '/app.js', '/images/journal-cover.jpg', '/vendor/icons.js']) {
    assert.equal((await request(resource, { authenticated: false })).status, 200, resource)
  }
  const manifest = await (await request('/manifest.webmanifest')).json()
  assert.equal(manifest.theme_color, '#a54363')
  console.log('通过：登录、图文发布、读取、相册、归档、私密边界、页面资源与主题。')
} finally {
  db?.close()
  rmSync(dataDir, { recursive: true, force: true })
}
