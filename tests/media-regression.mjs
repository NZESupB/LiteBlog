// 视频与实况图回归:原地播放器、流式上传、配对发布、Range 读取、可见性边界与删除清理。
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

// 原地播放器:同一时刻只有一个播放器,点收起或编码不支持时销毁并退回封面。
// 播放体验(全屏/画中画/倍速)由 ArtPlayer 提供,这里用最小假 DOM + 假播放器钉住我们的接线。
class FakeArtplayer {
  static instances = []
  constructor(option) {
    this.option = option
    this.destroyed = false
    this.played = 0
    this.events = new Map()
    this.video = { videoWidth: 0, videoHeight: 0 }
    FakeArtplayer.instances.push(this)
  }
  on(event, handler) { this.events.set(event, handler) }
  emit(event) { this.events.get(event)?.() }
  play() { this.played += 1; return Promise.resolve() }
  destroy() { this.destroyed = true }
}
globalThis.Artplayer = FakeArtplayer

const { playInlineVideo, stopInlineVideo, preloadInlineVideoPlayer } = await import('../public/js/inline-video.js')

function fakeTile({ singleColumn = false, poster = null, player = true } = {}) {
  const classes = new Set()
  const container = { hidden: true }
  const collapse = { hidden: true }
  const nodes = { '.media-player': player ? container : null, '.media-collapse': collapse, img: poster }
  return {
    container, collapse,
    style: { aspectRatio: '' },
    closest: (sel) => (singleColumn && sel === '.img-grid.n1' ? {} : null),
    querySelector: (sel) => nodes[sel] ?? null,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    playing: () => classes.has('is-playing'),
  }
}

const clip = { url: '/uploads/a.mp4', poster: '/uploads/a.jpg' }
const tileA = fakeTile({ poster: { naturalWidth: 640, naturalHeight: 360 } })
assert.equal(FakeArtplayer.instances.length, 0, '没点之前不能建播放器,列表也不该去加载视频文件')
playInlineVideo(tileA, clip)
const artA = FakeArtplayer.instances.at(-1)
assert.equal(FakeArtplayer.instances.length, 1)
assert.equal(artA.option.url, clip.url)
assert.equal(artA.option.poster, clip.poster)
// 「内嵌也要有全屏/设置/画中画」就落在这些开关上,别在裁剪时手滑关掉
assert.equal(artA.option.autoplay, false, '播放只由用户点击触发,不能自动播放')
assert.equal(artA.option.fullscreen, true, '要有全屏')
assert.equal(artA.option.pip, true, '要有画中画')
assert.equal(artA.option.setting, true, '要有设置面板')
assert.equal(artA.option.playbackRate, true, '设置里要有倍速')
assert.equal(artA.option.aspectRatio, true, '设置里要有画面比例')
assert.equal(artA.option.moreVideoAttr.playsInline, true, 'iOS 要能内嵌播')
assert.equal(artA.played, 1, '点封面即播,不再等第二次点击')
assert.equal(tileA.playing(), true)
assert.equal(tileA.container.hidden, false)
assert.equal(tileA.collapse.hidden, false)
assert.equal(tileA.style.aspectRatio, '640 / 360', '先把格子按封面比例铺开,免得等元数据时跳一下')
artA.video.videoWidth = 480
artA.video.videoHeight = 854
artA.emit('video:loadedmetadata')
assert.equal(tileA.style.aspectRatio, '480 / 854', '元数据到手后按真实画面比例校正')

const plainTile = fakeTile({ player: false }) // 图片格子:只有点击层,没有播放器容器
playInlineVideo(plainTile, clip)
assert.equal(FakeArtplayer.instances.length, 1, '图片格子没有播放器容器,不能被当成视频格')
assert.equal(tileA.playing(), true, '也不能把在播的那个挤掉')

const tileB = fakeTile()
playInlineVideo(tileB, { url: '/uploads/b.mp4' })
const artB = FakeArtplayer.instances.at(-1)
assert.equal(artA.destroyed, true, '开始播第二个时第一个要销毁')
assert.equal(tileA.playing(), false)
assert.equal(tileA.container.hidden, true)
assert.equal(tileA.collapse.hidden, true)
assert.equal(tileA.style.aspectRatio, '', '收起后要清掉播放时的比例,回到封面尺寸')
assert.equal(artB.destroyed, false)
assert.equal(tileB.playing(), true)

const soloTile = fakeTile({ singleColumn: true, poster: { naturalWidth: 640, naturalHeight: 360 } })
playInlineVideo(soloTile, clip)
const artSolo = FakeArtplayer.instances.at(-1)
assert.equal(artB.destroyed, true, '单列格子同样共享「只有一个在播」')
assert.equal(soloTile.style.aspectRatio, '', '单列格子本来就够大,不跟着画面比例改尺寸')
artSolo.video.videoWidth = 480
artSolo.video.videoHeight = 854
artSolo.emit('video:loadedmetadata')
assert.equal(soloTile.style.aspectRatio, '', '单列格子拿到元数据也不重排')

let notified = 0
const tileC = fakeTile()
playInlineVideo(tileC, clip, { onError: () => { notified += 1 } })
const artC = FakeArtplayer.instances.at(-1)
artC.emit('video:error') // 浏览器解不了这个编码(例如 Chrome 播 HEVC)
assert.equal(notified, 1, '播放失败要回调出去,交给界面提示用户')
assert.equal(artC.destroyed, true)
assert.equal(tileC.playing(), false)
assert.equal(tileC.container.hidden, true)

stopInlineVideo()
assert.equal(FakeArtplayer.instances.every((art) => art.destroyed), true)
assert.ok((await preloadInlineVideoPlayer()) === FakeArtplayer, '已经有了就不要再插脚本标签')

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
    assert.equal(res.status, 202, text)
    const task = JSON.parse(text)
    assert.equal(task.status, 'saving')
    assert.equal(task.size, bytes.length)
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      const stateRes = await request(`/api/uploads/video/${task.uploadId}`)
      const stateText = await stateRes.text()
      assert.equal(stateRes.status, 200, stateText)
      const state = JSON.parse(stateText)
      if (state.status === 'failed') assert.fail(state.error || '视频保存失败')
      if (state.status === 'done') {
        assert.equal(state.size, bytes.length)
        return state.filename
      }
    }
    assert.fail('视频后台保存未结束')
  }

  // 视频:内容不参与去重(同名随机段),后台保存完成后可从 /uploads 读到
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

  // Range 请求必须回 206 与正确的 Content-Range/Slice。
  // iOS Safari 会先发 bytes=0-;即使覆盖整个文件,也不能降级成 200。
  const openRangeRes = await request(post.images[2].url, { headers: { Range: 'bytes=0-' } })
  assert.equal(openRangeRes.status, 206)
  assert.equal(openRangeRes.headers.get('content-range'), `bytes 0-${videoBytes.length - 1}/${videoBytes.length}`)
  assert.equal(openRangeRes.headers.get('content-length'), String(videoBytes.length))
  assert.equal((await openRangeRes.arrayBuffer()).byteLength, videoBytes.length)
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
  const user2 = await request('/api/login', { method: 'POST', body: { username: 'user2', password: 'pass2' } })
  const user1Cookie = cookie
  cookie = user2.headers.get('set-cookie').split(';')[0]
  await request('/api/drafts', { method: 'POST', body: { id: otherDraft } })
  const foreignName = await uploadVideo(videoBytes, 'video/mp4', otherDraft)
  cookie = user1Cookie
  const hijack = await request('/api/posts', { method: 'POST', body: { content: 'x', images: [foreignName] } })
  assert.equal(hijack.status, 400)

  console.log('通过：视频流式上传、实况配对、发布契约、Range 206、相册、可见性边界与删除清理。')
} finally {
  db?.close()
  rmSync(dataDir, { recursive: true, force: true })
}
