// 视频与实况图回归:流式上传、配对发布、Range 读取、可见性边界与删除清理。
// 执行: node tests/media-regression.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 实况图配对规则是纯函数,先在 Node 里把边界钉死(浏览器里跑的是同一份代码)
const { groupMediaFiles, mediaStem, isVideoFile, videoContentType } = await import('../public/js/media.js')
const file = (name, type) => new File([new Uint8Array([1, 2, 3])], name, type ? { type } : undefined)
const shape = (files) => groupMediaFiles(files).map((g) => [g.still?.name, g.motion?.name, g.video?.name].filter(Boolean).join('+'))
assert.deepEqual(shape([file('IMG_0001.JPG', 'image/jpeg'), file('IMG_0001.MOV', 'video/quicktime')]), ['IMG_0001.JPG+IMG_0001.MOV'])
assert.deepEqual(shape([file('IMG_0001.MOV', 'video/quicktime'), file('IMG_0001.JPG', 'image/jpeg')]), ['IMG_0001.JPG+IMG_0001.MOV'])
assert.deepEqual(shape([file('a.jpg', 'image/jpeg'), file('b.mp4', 'video/mp4')]), ['a.jpg', 'b.mp4'])
// 同一主干上多出来的静帧不能挂到同一个动态部分上,也不该被吞掉
assert.deepEqual(shape([file('x.jpg', 'image/jpeg'), file('x.png', 'image/png'), file('x.mp4', 'video/mp4')]), ['x.jpg+x.mp4', 'x.png'])
// 浏览器给 HEIC / MOV 的 type 可能是空的,这时候要靠扩展名判断
assert.deepEqual(shape([file('IMG_1.HEIC'), file('IMG_1.MOV')]), ['IMG_1.HEIC+IMG_1.MOV'])
// Google Takeout 导出的实况图是 jpg + mp4 同名配对
assert.deepEqual(shape([file('IMG_0002.jpg', 'image/jpeg'), file('IMG_0002.mp4', 'video/mp4')]), ['IMG_0002.jpg+IMG_0002.mp4'])
assert.equal(mediaStem('IMG_0001.HEIC'), 'IMG_0001')
assert.equal(isVideoFile(file('IMG_0001.MOV')), true)
assert.equal(videoContentType(file('a.MOV')), 'video/quicktime')
assert.equal(videoContentType(file('a.webm', '')), 'video/webm')

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(path.join(root, 'data'), { recursive: true })
const dataDir = mkdtempSync(path.join(root, 'data', 'media-regression-'))
const { setConfigForTests } = await import('../server/config.js')
// 上限压到 4KB,让「超限」用例不用真的传 200MB
setConfigForTests({
  server: { dataDir },
  security: { jwtSecret: 'isolated-media-regression' },
  site: { privateMode: true },
  storage: { backend: 'local' },
  media: { maxVideoBytes: 4096 },
})

let db
let TMP_DIR
try {
  const { app } = await import('../server/index.js')
  ;({ db, TMP_DIR } = await import('../server/db.js'))
  const coverJpeg = readFileSync(path.join(root, 'public/images/journal-cover.jpg'))
  let cookie = ''
  async function request(url, { method = 'GET', body, authenticated = true, headers = {} } = {}) {
    const next = new Headers(headers)
    if (cookie && authenticated) next.set('Cookie', cookie)
    if (body && !(body instanceof FormData) && !(body instanceof Uint8Array)) {
      next.set('Content-Type', 'application/json')
      body = JSON.stringify(body)
    }
    return app.request(url, { method, headers: next, body })
  }
  const login = await request('/api/login', { method: 'POST', body: { username: 'user1', password: 'pass1' } })
  assert.equal(login.status, 200)
  cookie = login.headers.get('set-cookie').split(';')[0]
  const draftId = 'media-regression-draft'
  assert.equal((await request('/api/drafts', { method: 'POST', body: { id: draftId } })).status, 200)

  async function uploadImage(bytes, name, type = 'image/jpeg', draft = draftId) {
    const form = new FormData()
    form.append('image', new Blob([bytes], { type }), name)
    form.append('draftId', draft)
    const res = await request('/api/uploads', { method: 'POST', body: form })
    const text = await res.text()
    assert.equal(res.status, 200, text)
    return JSON.parse(text).filename
  }
  async function uploadVideo(bytes, type = 'video/mp4', draft = draftId) {
    const res = await request(`/api/uploads/video?draftId=${draft}`, { method: 'POST', body: bytes, headers: { 'Content-Type': type } })
    const text = await res.text()
    assert.equal(res.status, 200, text)
    return JSON.parse(text).filename
  }

  // 视频:内容不参与去重(同名随机段),上传后立刻可从 /uploads 读到
  const videoBytes = new Uint8Array(1000).map((_, i) => (i * 7) % 251)
  const videoName = await uploadVideo(videoBytes)
  assert.match(videoName, /^\d{8}-\d{6}-[a-f0-9]{8}\.mp4$/)
  const videoPoster = await uploadImage(coverJpeg, 'poster.jpg')

  // 实况图:静帧 + 配对视频 + 另一张普通静帧
  const still = await uploadImage(coverJpeg, 'IMG_0001.HEIC')
  const motionName = await uploadVideo(videoBytes, 'video/quicktime')
  assert.match(motionName, /\.mov$/)
  const plain = await uploadImage(coverJpeg, 'IMG_0002.jpg')

  // 超上限:声明长度与真实长度都被校验
  const oversized = new Uint8Array(8192)
  const tooLarge = await request(`/api/uploads/video?draftId=${draftId}`, {
    method: 'POST', body: oversized, headers: { 'Content-Type': 'video/mp4' },
  })
  assert.equal(tooLarge.status, 413)
  assert.equal((await request(`/api/uploads/video?draftId=${draftId}`, {
    method: 'POST', body: new Uint8Array(10), headers: { 'Content-Type': 'video/x-msvideo' },
  })).status, 400)
  // 半截临时文件不能留下
  assert.equal((await readdir(TMP_DIR)).length, 0)

  // 发布:images 同时收字符串(旧格式)与对象(带配对/封面/时长)
  const created = await request('/api/posts', {
    method: 'POST',
    body: {
      draftId,
      content: '媒体回归:视频与实况图。',
      images: [plain, { filename: still, motion: motionName }, { filename: videoName, poster: videoPoster, duration: 12.5 }],
      publicText: true,
      publicImages: true,
    },
  })
  const createdText = await created.text()
  assert.equal(created.status, 200, createdText)
  const { id: postId } = JSON.parse(createdText)

  const { posts } = await (await request('/api/posts')).json()
  const post = posts.find((p) => p.id === postId)
  assert.equal(post.images.length, 3)
  assert.equal(post.images[0].type, 'image')
  assert.equal(post.images[0].live, undefined)
  assert.equal(post.images[1].type, 'image')
  assert.equal(post.images[1].live, true)
  assert.equal(post.images[1].motion, `/uploads/${motionName}`)
  assert.equal(post.images[2].type, 'video')
  assert.equal(post.images[2].poster, `/uploads/${videoPoster}`)
  assert.equal(post.images[2].duration, 12.5)

  // 配对文件与封面都能按各自地址读到
  assert.equal((await request(post.images[1].motion)).status, 200)
  assert.equal((await request(post.images[2].poster)).status, 200)
  const videoRes = await request(post.images[2].url)
  assert.equal(videoRes.status, 200)
  assert.equal(videoRes.headers.get('accept-ranges'), 'bytes')
  assert.equal(videoRes.headers.get('content-type'), 'video/mp4')
  assert.equal((await videoRes.arrayBuffer()).byteLength, videoBytes.length)

  // Range 请求必须回 206 与正确的 Content-Range/Slice
  const rangeRes = await request(post.images[2].url, { headers: { Range: 'bytes=0-9' } })
  assert.equal(rangeRes.status, 206)
  assert.equal(rangeRes.headers.get('content-range'), `bytes 0-9/${videoBytes.length}`)
  assert.equal(rangeRes.headers.get('content-length'), '10')
  const slice = new Uint8Array(await rangeRes.arrayBuffer())
  assert.equal(slice.length, 10)
  assert.deepEqual([...slice], [...videoBytes.slice(0, 10)])
  const suffixRes = await request(post.images[2].url, { headers: { Range: 'bytes=-5' } })
  assert.equal(suffixRes.status, 206)
  assert.equal(suffixRes.headers.get('content-range'), `bytes ${videoBytes.length - 5}-${videoBytes.length - 1}/${videoBytes.length}`)
  // 越界区间按整段返回,不能让播放器看到空响应
  assert.equal((await request(post.images[2].url, { headers: { Range: 'bytes=999999-' } })).status, 200)

  // 相册与时间轴同形:视频给封面,实况给静帧
  const gallery = await (await request('/api/gallery')).json()
  assert.equal(gallery.images.length, 3)
  const galleryVideo = gallery.images.find((i) => i.type === 'video')
  assert.equal(galleryVideo.poster, `/uploads/${videoPoster}`)
  assert.equal(gallery.images.find((i) => i.live).motion, `/uploads/${motionName}`)

  // 公开动态的配对视频、封面与视频,访客都能读
  assert.equal((await request(`/uploads/${motionName}`, { authenticated: false })).status, 200)
  assert.equal((await request(`/uploads/${videoPoster}`, { authenticated: false })).status, 200)
  assert.equal((await request(`/uploads/${videoName}`, { authenticated: false })).status, 200)

  // 私密模式:public_images 关掉的动态,访客读主文件、配对视频、封面一律 401
  const privateDraft = 'media-regression-private'
  await request('/api/drafts', { method: 'POST', body: { id: privateDraft } })
  const privateVideo = await uploadVideo(videoBytes, 'video/mp4', privateDraft)
  // 内容必须与前一条动态里的图不同:相同内容会命中既有的按 hash 去重,复用同一个文件
  const privatePoster = await uploadImage(Buffer.concat([coverJpeg, Buffer.from('poster')]), 'private-poster.jpg', 'image/jpeg', privateDraft)
  const privateStill = await uploadImage(Buffer.concat([coverJpeg, Buffer.from('still')]), 'IMG_9001.jpg', 'image/jpeg', privateDraft)
  const privateMotion = await uploadVideo(videoBytes, 'video/quicktime', privateDraft)
  const privatePost = await (await request('/api/posts', {
    method: 'POST',
    body: {
      draftId: privateDraft,
      content: '仅登录可见',
      images: [privateStill, { filename: privateStill, motion: privateMotion }, { filename: privateVideo, poster: privatePoster }],
      publicText: false,
      publicImages: false,
    },
  })).json()
  assert.ok(privatePost.id)
  for (const name of [privateVideo, privatePoster, privateStill, privateMotion]) {
    assert.equal((await request(`/uploads/${name}`, { authenticated: false })).status, 401, name)
  }

  // 删除动态:主文件、配对视频、封面三个文件都要清掉
  const filesBefore = [still, motionName]
  assert.equal((await request(`/api/posts/${postId}`, { method: 'DELETE' })).status, 200)
  for (const name of filesBefore) assert.equal((await request(`/uploads/${name}`)).status, 404, name)
  assert.equal((await request(`/uploads/${videoPoster}`)).status, 404)
  assert.equal((await request(`/api/posts/${privatePost.id}`, { method: 'DELETE' })).status, 200)
  for (const name of [privateVideo, privatePoster, privateStill, privateMotion]) {
    assert.equal((await request(`/uploads/${name}`)).status, 404, name)
  }

  // 上传到别的草稿/别的账号的视频不能被我挂到自己的动态上
  const otherDraft = 'media-regression-other'
  await request('/api/drafts', { method: 'POST', body: { id: otherDraft } })
  const user2 = await request('/api/login', { method: 'POST', body: { username: 'user2', password: 'pass2' } })
  const user1Cookie = cookie
  cookie = user2.headers.get('set-cookie').split(';')[0]
  const foreign = await request(`/api/uploads/video?draftId=${otherDraft}`, {
    method: 'POST', body: videoBytes, headers: { 'Content-Type': 'video/mp4' },
  })
  const foreignName = (await foreign.json()).filename
  cookie = user1Cookie
  const hijack = await request('/api/posts', { method: 'POST', body: { content: 'x', images: [foreignName] } })
  assert.equal(hijack.status, 400)

  console.log('通过：视频流式上传、实况配对、发布契约、Range 206、相册、可见性边界与删除清理。')
} finally {
  db?.close()
  rmSync(dataDir, { recursive: true, force: true })
}
