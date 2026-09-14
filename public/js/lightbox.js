// 媒体灯箱:图片、视频、实况图共用一个序列。刻意不自动播放 ——
// 视频只有 cover 图,进灯箱也停在封面等用户点播放;实况图的动态部分要点 LIVE 角标才播。
import { animatePresence } from '/js/sheet-motion.js'

const lightbox = document.getElementById('lightbox')
const stage = document.getElementById('lightboxStage')
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

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration))

// 当前真正占据画面中心、参与展开/收起动画的节点
const activeNode = () => (videoEl.hidden ? imageEl : videoEl)
const currentItem = () => items[index] || null

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
function applyItem() {
  const item = currentItem()
  if (!item) return
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
  return waitForImage(imageEl, item.url)
}

function playLive() {
  const item = currentItem()
  if (!item?.motion) return
  livePlaying = true
  imageEl.hidden = true
  videoEl.hidden = false
  // 实况片段是几秒的环境音录像,不做进度条,点画面暂停/继续,播完自动回到静帧
  videoEl.controls = false
  liveBtn.hidden = true
  liveBtn.setAttribute('aria-pressed', 'true')
  void waitForVideo(videoEl, item.motion, item.url).then(() => {
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
  if (!items.length || lightbox.hidden) return
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
lightbox.onclick = (event) => { if (event.target === lightbox || event.target === stage) closeLightbox() }
document.addEventListener('keydown', (event) => {
  if (lightbox.hidden) return
  if (event.key === 'Escape') { closeLightbox(); return }
  if (event.key === 'ArrowLeft') { event.preventDefault(); void move(-1); return }
  if (event.key === 'ArrowRight') { event.preventDefault(); void move(1); return }
  if (event.key === ' ' || event.key === 'Enter') {
    if (event.target?.closest?.('.lightbox video')) return
    event.preventDefault()
    togglePlayback()
  }
})
