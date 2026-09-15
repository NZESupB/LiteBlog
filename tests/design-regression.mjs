// 使用内置断言验证改版涉及的页面资源与图文流程,不引入测试依赖。
// 执行: node tests/design-regression.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(path.join(root, 'data'), { recursive: true })
const dataDir = mkdtempSync(path.join(root, 'data', 'design-regression-'))
const { setConfigForTests } = await import('../server/config.js')
setConfigForTests({
  server: { dataDir },
  security: { jwtSecret: 'isolated-design-regression' },
  site: { privateMode: true },
  storage: { backend: 'local' },
})

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
  const draftId = 'design-regression-draft'
  assert.equal((await request('/api/drafts', { method: 'POST', body: { id: draftId } })).status, 200)
  const imageConfig = await request('/api/image-jobs/config')
  assert.equal(imageConfig.status, 200)
  const imageConfigBody = await imageConfig.json()
  assert.equal(imageConfigBody.model, 'gpt-image-2')
  assert.equal(imageConfigBody.baseUrl, '')
  assert.equal((await request('/api/image-jobs/config', { method: 'PUT', body: { baseUrl: 'https://img.test/v1', apiKey: 'test-key' } })).status, 200)
  const savedImageConfig = await (await request('/api/image-jobs/config')).json()
  assert.equal(savedImageConfig.baseUrl, 'https://img.test/v1')
  assert.equal(savedImageConfig.hasApiKey, true)

  const avatarForm = new FormData()
  avatarForm.append('avatar', new Blob([readFileSync(path.join(root, 'public/images/journal-cover.jpg'))], { type: 'image/jpeg' }), 'avatar.jpg')
  const invalidAvatarForm = new FormData()
  invalidAvatarForm.append('avatar', new Blob(['not an image'], { type: 'image/jpeg' }), 'avatar.jpg')
  assert.equal((await request('/api/profile/avatar', { method: 'POST', body: invalidAvatarForm })).status, 400)
  const avatarUpload = await request('/api/profile/avatar', { method: 'POST', body: avatarForm })
  assert.equal(avatarUpload.status, 200)
  const avatar = await avatarUpload.json()
  assert.match(avatar.avatarUrl, /^\/avatars\/avatar-1-/)
  assert.equal((await request(avatar.avatarUrl)).status, 200)
  assert.equal((await (await request('/api/site')).json()).user.avatarUrl, avatar.avatarUrl)

  const form = new FormData()
  form.append('image', new Blob([readFileSync(path.join(root, 'public/images/journal-cover.jpg'))], { type: 'image/jpeg' }), 'cover.jpg')
  form.append('draftId', draftId)
  const uploaded = await request('/api/uploads', { method: 'POST', body: form })
  assert.equal(uploaded.status, 200)
  const upload = await uploaded.json()
  const published = await request('/api/posts', { method: 'POST', body: { draftId, content: '改版回归：一起记录今天。', images: [upload.filename] } })
  assert.ok(published.ok)
  const { id } = await published.json()
  const { posts } = await (await request('/api/posts')).json()
  assert.equal(posts[0].id, id)
  assert.equal(posts[0].content, '改版回归：一起记录今天。')
  assert.equal(posts[0].images.length, 1)
  assert.equal(posts[0].avatarUrl, avatar.avatarUrl)
  const draftSnapshot = await (await request(`/api/drafts/${draftId}`)).json()
  assert.equal(draftSnapshot.draft.status, 'published')
  assert.equal((await request('/api/drafts', { method: 'POST', body: { id: draftId } })).status, 200)
  const duplicatePublish = await request('/api/posts', { method: 'POST', body: { draftId, content: '改版回归：一起记录今天。', images: [upload.filename] } })
  assert.equal((await duplicatePublish.json()).id, id)

  // 同一张图片不能把另一位用户或另一份草稿的待引用归属覆盖掉。
  const user1Cookie = cookie
  const user2Login = await request('/api/login', { method: 'POST', body: { username: 'user2', password: 'pass2' } })
  assert.equal(user2Login.status, 200)
  const user2Cookie = user2Login.headers.get('set-cookie').split(';')[0]
  cookie = user2Cookie
  await request('/api/drafts', { method: 'POST', body: { id: 'other-user-draft' } })
  const otherUserForm = new FormData()
  otherUserForm.append('image', new Blob([readFileSync(path.join(root, 'public/images/journal-cover.jpg'))], { type: 'image/jpeg' }), 'cover.jpg')
  otherUserForm.append('draftId', 'other-user-draft')
  const otherUserUpload = await request('/api/uploads', { method: 'POST', body: otherUserForm })
  assert.equal(otherUserUpload.status, 200)
  assert.notEqual((await otherUserUpload.json()).filename, upload.filename)
  await request('/api/drafts/other-user-draft', { method: 'DELETE' })

  cookie = user1Cookie
  await request('/api/drafts', { method: 'POST', body: { id: 'same-user-draft-a' } })
  await request('/api/drafts', { method: 'POST', body: { id: 'same-user-draft-b' } })
  const sameUserForm = () => {
    const next = new FormData()
    next.append('image', new Blob([readFileSync(path.join(root, 'public/images/journal-cover.jpg'))], { type: 'image/jpeg' }), 'cover.jpg')
    return next
  }
  const sameUserFormA = sameUserForm()
  sameUserFormA.append('draftId', 'same-user-draft-a')
  const sameUserUploadA = await request('/api/uploads', { method: 'POST', body: sameUserFormA })
  const sameUserNameA = (await sameUserUploadA.json()).filename
  const sameUserFormB = sameUserForm()
  sameUserFormB.append('draftId', 'same-user-draft-b')
  const sameUserUploadB = await request('/api/uploads', { method: 'POST', body: sameUserFormB })
  const sameUserNameB = (await sameUserUploadB.json()).filename
  assert.notEqual(sameUserNameA, sameUserNameB)
  const sameUserDraftA = await (await request('/api/drafts/same-user-draft-a')).json()
  assert.equal(sameUserDraftA.pending.length, 1)
  assert.equal(sameUserDraftA.pending[0].filename, sameUserNameA)
  await request('/api/drafts/same-user-draft-a', { method: 'DELETE' })
  await request('/api/drafts/same-user-draft-b', { method: 'DELETE' })

  const abandonedDraft = 'design-regression-abandoned'
  await request('/api/drafts', { method: 'POST', body: { id: abandonedDraft } })
  assert.equal((await request(`/api/drafts/${abandonedDraft}`, { method: 'DELETE' })).status, 200)
  assert.equal((await (await request(`/api/drafts/${abandonedDraft}`)).json()).draft.status, 'abandoned')
  const gallery = await (await request('/api/gallery')).json()
  assert.equal(gallery.images.length, 1)
  assert.equal((await request(gallery.images[0].url)).status, 200)
  assert.equal((await (await request('/api/posts/archive?tz=-480')).json()).total, 1)

  const guestPosts = await (await request('/api/posts', { authenticated: false })).json()
  assert.equal(guestPosts.posts[0].content, '')
  assert.equal(guestPosts.posts[0].images.length, 0)
  assert.equal((await request('/api/gallery', { authenticated: false })).status, 401)
  assert.equal((await request(upload.url, { authenticated: false })).status, 401)
  assert.equal((await request(avatar.avatarUrl, { authenticated: false })).status, 200)
  assert.equal((await request('/api/profile/avatar', { method: 'DELETE' })).status, 200)
  assert.equal((await (await request('/api/site')).json()).user.avatarUrl, null)
  for (const resource of ['/', '/style.css', '/app.js', '/js/theme.js', '/js/sheet-motion.js', '/js/composer-viewport.js', '/images/journal-cover.jpg', '/vendor/icons.js', '/vendor/artplayer.min.js']) {
    assert.equal((await request(resource, { authenticated: false })).status, 200, resource)
  }
  const manifest = await (await request('/manifest.webmanifest')).json()
  assert.equal(manifest.theme_color, '#a54363')
  // 灯箱的三件套:一图一视频一 LIVE 角标,全部由用户点击才播(脚本里搜不到 autoplay)
  const shell = await (await request('/index.html')).text()
  for (const id of ['lightboxImg', 'lightboxVideo', 'lightboxLive']) assert.ok(shell.includes(`id="${id}"`), id)
  assert.ok(shell.includes('playsinline'))
  assert.ok(!/autoplay/.test(shell))
  for (const asset of ['/js/lightbox.js', '/js/media.js', '/js/inline-video.js']) {
    const body = await (await request(asset)).text()
    assert.ok(!/autoplay\s*=/.test(body), `${asset} 不应自行自动播放`)
  }
  console.log('通过：登录、图文发布、读取、相册、归档、私密边界、页面资源、灯箱外壳与主题。')
} finally {
  db?.close()
  rmSync(dataDir, { recursive: true, force: true })
}
