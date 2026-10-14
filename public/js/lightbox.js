// 媒体灯箱:图片、视频、实况图共用一个序列。刻意不自动播放 ——
// 视频只有 cover 图,进灯箱也停在封面等用户点播放;实况图的动态部分要点 LIVE 角标才播。
import { animatePresence } from '/js/sheet-motion.js'

const lightbox = document.getElementById('lightbox')
const stage = document.getElementById('lightboxStage')
const viewport = document.getElementById('lightboxViewport')
const imageEl = document.getElementById('lightboxImg')
const videoEl = document.getElementById('lightboxVideo')
const liveBtn = document.getElementById('lightboxLive')
const closeBtn = document.querySelector('.lb-close')
const prevBtn = document.querySelector('.lb-prev')
const nextBtn = document.querySelector('.lb-next')

let items = []
let index = 0
let trigger = null
let motionToken = 0
let switchToken = 0
let livePlaying = false
let zoom = 1
let pinch = null
let ignoreBackdropUntil = 0

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration))

// 当前真正占据画面中心、参与展开/收起动画的节点
const activeNode = () => (videoEl.hidden ? imageEl : videoEl)
const currentItem = () => items[index] || null

// 用真实布局尺寸承载缩放，放大的四边和长图底部都在滚动范围内。
function layoutImage() {
  if (imageEl.hidden || !imageEl.naturalWidth) return
  const width = Math.min(imageEl.naturalWidth, viewport.clientWidth) * zoom
  imageEl.style.width = `${width}px`
  imageEl.style.height = `${width * imageEl.naturalHeight / imageEl.naturalWidth}px`
  imageEl.classList.toggle('is-zoomed', zoom > 1)
}

function resetView() {
  zoom = 1
  pinch = null
  viewport.scrollTop = 0
  viewport.scrollLeft = 0
  imageEl.classList.remove('is-zoomed')
  imageEl.style.width = ''
  imageEl.style.height = ''
}

function zoomAt(value, clientX, clientY) {
  if (imageEl.hidden || !imageEl.naturalWidth) return
  const before = imageEl.getBoundingClientRect()
  const x = (clientX - before.left) / before.width
  const y = (clientY - before.top) / before.height
  zoom = Math.max(1, Math.min(4, value))
  layoutImage()
  const after = imageEl.getBoundingClientRect()
  viewport.scrollLeft += after.left + x * after.width - clientX
  viewport.scrollTop += after.top + y * after.height - clientY
  ignoreBackdropUntil = performance.now() + 350
}

function waitForImage(image, url) {
  image.src = url
  if (image.complete && image.naturalWidth) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => { image.removeEventListener('load', done); image.removeEventListener('error', done); resolve() }
    image.addEventListener('load', done)
    image.addEventListener('error', done)
  })
}

function preloadImage(url) {
  const image = new Image()
  image.src = url
  if (image.complete && image.naturalWidth) return Promise.resolve()
  return new Promise((resolve) => { image.onload = resolve; image.onerror = resolve })
}

function waitForVideo(node, src, poster) {
  node.poster = poster || ''
  node.src = src
  node.load()
  // 只要元数据到手就能定位尺寸;拿不到(编码不支持)时也让灯箱照常打开,停在封面上
  return new Promise((resolve) => {
    const done = () => {
      node.removeEventListener('loadeddata', done)
      node.removeEventListener('error', done)
      resolve()
    }
    node.addEventListener('loadeddata', done)
    node.addEventListener('error', done)
  })
}

function measureNode(node) {
  const transform = node.style.transform
  const transition = node.style.transition
  node.style.transition = 'none'
  node.style.transform = 'none'
  const rect = node.getBoundingClientRect()
  node.style.transform = transform
  node.style.transition = transition
  return rect
}

function transformToRect(from, to) {
  if (!from || !to || !to.width || !to.height) return 'translateY(12px) scale(.98)'
  const scaleX = Math.max(.01, from.width / to.width)
  const scaleY = Math.max(.01, from.height / to.height)
  const x = from.left + from.width / 2 - (to.left + to.width / 2)
  const y = from.top + from.height / 2 - (to.top + to.height / 2)
  return `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`
}

function setNodeTransition(node, enabled = true) {
  node.style.transition = enabled && !reducedMotion()
    ? 'transform var(--motion-spring-duration) var(--motion-ease), opacity var(--motion-standard-duration) var(--motion-ease)'
    : 'none'
}

function resetVideo() {
  try { videoEl.pause() } catch {}
  videoEl.removeAttribute('src')
  videoEl.removeAttribute('poster')
  videoEl.hidden = true
}

// 灯箱一次只呈现一个媒体项:视频项停在封面,实况图先给静帧
async function applyItem() {
  const item = currentItem()
  if (!item) return
  resetView()
  for (const node of [imageEl, videoEl]) {
    node.style.transition = 'none'
    node.style.transform = 'none'
    node.style.opacity = '1'
  }
  livePlaying = false
  liveBtn.hidden = true
  liveBtn.setAttribute('aria-pressed', 'false')
  if (item.type === 'video') {
    imageEl.hidden = true
    videoEl.hidden = false
    videoEl.controls = true
    videoEl.loop = false
    return waitForVideo(videoEl, item.url, item.poster)
  }
  resetVideo()
  imageEl.hidden = false
  if (item.live && item.motion) {
    liveBtn.hidden = false
    liveBtn.textContent = 'LIVE'
  }
  // 切图时已经用 preloadImage 预热过,这里直接换 src 不会闪
  await waitForImage(imageEl, item.url)
  if (currentItem() === item && !lightbox.hidden) layoutImage()
}

function playLive() {
  const item = currentItem()
  if (!item?.motion) return
  livePlaying = true
  imageEl.hidden = true
  videoEl.hidden = false
  resetView()
  // 实况片段是几秒的环境音录像,不做进度条,点画面暂停/继续,播完自动回到静帧
  videoEl.controls = false
  liveBtn.hidden = true
  liveBtn.setAttribute('aria-pressed', 'true')
  void waitForVideo(videoEl, item.motion, item.url).then(() => {
    if (lightbox.hidden || currentItem() !== item || !livePlaying) return
    // 声音保留:是用户主动点击触发的播放
    videoEl.play().catch(() => {})
  })
}

function stopLive() {
  if (!livePlaying) return
  livePlaying = false
  resetVideo()
  const item = currentItem()
  if (item?.type === 'image') {
    imageEl.hidden = false
    liveBtn.hidden = !item.live
    liveBtn.setAttribute('aria-pressed', 'false')
    layoutImage()
  }
}

function startOpen(origin, token) {
  if (token !== motionToken || lightbox.hidden) return
  const node = activeNode()
  const target = measureNode(node)
  const source = origin?.isConnected ? origin.getBoundingClientRect() : null
  node.style.transition = 'none'
  node.style.transform = transformToRect(source, target)
  node.style.opacity = source ? '.01' : '0'
  if (reducedMotion()) {
    node.style.transform = 'none'
    node.style.opacity = '1'
    return
  }
  void node.offsetWidth
  setNodeTransition(node)
  requestAnimationFrame(() => {
    if (token !== motionToken || lightbox.hidden) return
    node.style.transform = 'none'
    node.style.opacity = '1'
  })
}

// items: [{ type: 'image'|'video', url, poster?, motion?, live? }]
export function openLightbox(list, startIndex = 0, source = null) {
  if (!Array.isArray(list) || !list.length) return
  items = list
  index = Math.max(0, Math.min(list.length - 1, startIndex))
  const node = source instanceof Element ? source : null
  trigger = node?.closest('button, a') || node
  const token = ++motionToken
  ++switchToken
  lightbox.hidden = false
  document.body.classList.add('lightbox-open')
  closeBtn.focus({ preventScroll: true })
  const item = currentItem()
  void Promise.all([
    item.type === 'video' && item.poster ? preloadImage(item.poster) : Promise.resolve(),
    applyItem(),
  ]).then(() => startOpen(trigger, token))
  animatePresence(lightbox, true, { className: 'lightbox-presence', duration: 220 })
  syncNavButtons()
}

export function closeLightbox(immediate = false) {
  if (lightbox.hidden) return
  const token = ++motionToken
  ++switchToken
  const node = activeNode()
  const returnFocus = trigger
  const target = trigger?.isConnected ? trigger.getBoundingClientRect() : null
  const current = measureNode(node)
  setNodeTransition(node, !(immediate || reducedMotion()))
  node.style.transform = transformToRect(target, current)
  node.style.opacity = target ? '.01' : '0'
  const closing = animatePresence(lightbox, false, {
    className: 'lightbox-presence',
    duration: 340,
    immediate: immediate || reducedMotion(),
  })
  Promise.resolve(closing).then(() => {
    if (token !== motionToken) return
    node.style.transform = ''
    node.style.opacity = ''
    node.style.transition = ''
    resetVideo()
    livePlaying = false
    resetView()
    document.body.classList.remove('lightbox-open')
    returnFocus?.focus?.({ preventScroll: true })
    trigger = null
  })
}

function syncNavButtons() {
  const single = items.length <= 1
  prevBtn.hidden = single
  nextBtn.hidden = single
}

async function move(step) {
  if (!items.length || lightbox.hidden || lightbox.classList.contains('lightbox-presence-closing')) return
  ++motionToken
  const nextIndex = (index + step + items.length) % items.length
  const nextItem = items[nextIndex]
  const token = ++switchToken
  const node = activeNode()
  const preload = nextItem.type === 'video'
    ? (nextItem.poster ? preloadImage(nextItem.poster) : Promise.resolve())
    : preloadImage(nextItem.url)
  await preload
  if (token !== switchToken || lightbox.hidden) return
  if (reducedMotion()) {
    index = nextIndex
    await applyItem()
    return
  }
  const direction = step > 0 ? 1 : -1
  setNodeTransition(node)
  node.style.opacity = '0'
  node.style.transform = `translateX(${direction * 14}px) scale(.985)`
  await wait(140)
  if (token !== switchToken || lightbox.hidden) return
  index = nextIndex
  await applyItem()
  if (token !== switchToken || lightbox.hidden) return
  const next = activeNode()
  next.style.transition = 'none'
  next.style.transform = `translateX(${-direction * 14}px) scale(.985)`
  next.style.opacity = '0'
  void next.offsetWidth
  setNodeTransition(next)
  requestAnimationFrame(() => {
    if (token !== switchToken || lightbox.hidden) return
    next.style.transform = 'none'
    next.style.opacity = '1'
  })
}

function togglePlayback() {
  const item = currentItem()
  if (!item) return
  if (item.type !== 'video' && !livePlaying) { playLive(); return }
  if (videoEl.paused) videoEl.play().catch(() => {})
  else videoEl.pause()
}

closeBtn.onclick = () => closeLightbox()
prevBtn.onclick = () => { void move(-1) }
nextBtn.onclick = () => { void move(1) }
liveBtn.onclick = (event) => { event.stopPropagation(); playLive() }
// 实况片段播完自动回到静帧,iPhone 上就是这么收尾的
videoEl.onended = () => stopLive()
// 点画面暂停/继续实况片段(视频项用原生控件,不接管)
videoEl.onclick = () => { if (livePlaying) { if (videoEl.paused) videoEl.play().catch(() => {}); else videoEl.pause() } }
imageEl.ondblclick = (event) => {
  event.preventDefault()
  zoomAt(zoom > 1 ? 1 : 2, event.clientX, event.clientY)
}
viewport.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || imageEl.hidden) return
  event.preventDefault()
  zoomAt(zoom * Math.exp(-event.deltaY * .01), event.clientX, event.clientY)
}, { passive: false })
const touchGeometry = (touches) => ({
  x: (touches[0].clientX + touches[1].clientX) / 2,
  y: (touches[0].clientY + touches[1].clientY) / 2,
  distance: Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY),
})
viewport.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 2 || imageEl.hidden) return
  event.preventDefault()
  pinch = { ...touchGeometry(event.touches), zoom }
}, { passive: false })
viewport.addEventListener('touchmove', (event) => {
  if (!pinch || event.touches.length !== 2) return
  event.preventDefault()
  const point = touchGeometry(event.touches)
  if (pinch.distance > 0) zoomAt(pinch.zoom * point.distance / pinch.distance, pinch.x, pinch.y)
  viewport.scrollLeft += pinch.x - point.x
  viewport.scrollTop += pinch.y - point.y
  pinch.x = point.x
  pinch.y = point.y
}, { passive: false })
const endPinch = () => {
  if (pinch) ignoreBackdropUntil = performance.now() + 350
  pinch = null
}
viewport.addEventListener('touchend', endPinch)
viewport.addEventListener('touchcancel', endPinch)
viewport.addEventListener('scroll', () => { ignoreBackdropUntil = performance.now() + 350 }, { passive: true })
window.addEventListener('resize', () => { if (!lightbox.hidden) layoutImage() })
lightbox.onclick = (event) => {
  if (performance.now() < ignoreBackdropUntil) return
  if (event.target === lightbox || event.target === viewport || event.target === stage) closeLightbox()
}
document.addEventListener('keydown', (event) => {
  if (lightbox.hidden) return
  if (event.key === 'Escape') { closeLightbox(); return }
  if (event.key === 'ArrowLeft') { event.preventDefault(); void move(-1); return }
  if (event.key === 'ArrowRight') { event.preventDefault(); void move(1); return }
  if (['+', '=', '-', '0'].includes(event.key) && !imageEl.hidden) {
    event.preventDefault()
    const rect = viewport.getBoundingClientRect()
    zoomAt(event.key === '0' ? 1 : zoom * (event.key === '-' ? 1 / 1.25 : 1.25), rect.left + rect.width / 2, rect.top + rect.height / 2)
    return
  }
  if (event.key === ' ' || event.key === 'Enter') {
    if (event.target?.closest?.('.lightbox video, .lightbox button')) return
    event.preventDefault()
    togglePlayback()
  }
})
