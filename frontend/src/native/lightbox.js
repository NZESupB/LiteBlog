// 媒体灯箱：先加载解码，再提交画面；视频和实况图始终由用户主动播放。
import { animatePresence, animateElement, disposeAnimations, prefersReducedMotion, motionTiming, motionEasing } from './ui/motion.js'
import { createDialog } from './ui/dialog.js'

const lightbox = document.getElementById('lightbox')
const stage = document.getElementById('lightboxStage')
const viewport = document.getElementById('lightboxViewport')
let imageEl = document.getElementById('lightboxImg')
let videoEl = document.getElementById('lightboxVideo')
const liveBtn = document.getElementById('lightboxLive')
const statusText = document.getElementById('lightboxStatus')
const retryBtn = document.getElementById('lightboxRetry')
const closeBtn = document.querySelector('.lb-close')
const prevBtn = document.querySelector('.lb-prev')
const nextBtn = document.querySelector('.lb-next')
const modal = createDialog(lightbox, { closeOnBackdrop: false, onRequestClose: () => closeLightbox() })
const restTransform = 'translate(0px, 0px) scale(1)'

let items = []
let index = 0
let requestedIndex = 0
let trigger = null
let originUrl = ''
let motionToken = 0
let switchToken = 0
let livePlaying = false
let mediaReady = false
let closing = false
let closePromise = null
let retryAction = null
let zoom = 1
let pinch = null
let ignoreBackdropUntil = 0
let mediaLoad = null
let warmLoad = null
let warmImages = []

const activeNode = () => (videoEl.hidden ? imageEl : videoEl)
const currentItem = () => items[index] || null

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
  if (closing || imageEl.hidden || !imageEl.naturalWidth) return
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

function setStatus(message = '', busy = false, retry = null) {
  statusText.textContent = message
  viewport.setAttribute('aria-busy', String(busy))
  retryAction = retry
  retryBtn.hidden = !retry
}

// 加载失败与取消分别结束等待；取消不进入错误展示路径。
function waitForMedia(node, ready, start, signal) {
  return new Promise((resolve) => {
    const finish = (status) => {
      node.removeEventListener(ready, loaded)
      node.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
      resolve({ status, node })
    }
    const loaded = () => finish('ready')
    const failed = () => finish('error')
    const aborted = () => finish('cancelled')
    if (signal.aborted) { aborted(); return }
    node.addEventListener(ready, loaded, { once: true })
    node.addEventListener('error', failed, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
    try {
      start()
      if (ready === 'load' && node.complete) (node.naturalWidth ? loaded : failed)()
    } catch { failed() }
  })
}

function decodeImage(image, signal) {
  return new Promise((resolve) => {
    const finish = (status) => { signal.removeEventListener('abort', abort); resolve({ status, node: image }) }
    const abort = () => finish('cancelled')
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    image.decode().then(() => finish(signal.aborted ? 'cancelled' : 'ready'), () => finish(signal.aborted ? 'cancelled' : 'error'))
  })
}

async function prepareImage(image, url, signal) {
  let result = await waitForMedia(image, 'load', () => { image.src = url }, signal)
  if (result.status === 'ready') result = await decodeImage(image, signal)
  if (result.status !== 'ready') image.removeAttribute('src')
  return result
}

function releaseVideo(node) {
  node.pause()
  node.loop = false
  node.removeAttribute('src')
  node.removeAttribute('poster')
  node.load()
}

async function prepareMedia(item, signal) {
  if (item.type !== 'video') return prepareImage(new Image(), item.url, signal)
  const node = document.createElement('video')
  node.playsInline = true
  const result = await waitForMedia(node, 'loadeddata', () => {
    node.poster = item.poster || ''
    node.src = item.url
    node.load()
  }, signal)
  if (result.status !== 'ready') releaseVideo(node)
  return result
}

function clearWarmImages() {
  warmLoad?.abort()
  warmLoad = null
  for (const image of warmImages) image.removeAttribute('src')
  warmImages = []
}

function warmAdjacent() {
  clearWarmImages()
  warmLoad = new AbortController()
  const urls = new Set()
  for (const step of [-1, 1]) {
    const item = items[(index + step + items.length) % items.length]
    const url = item?.type === 'video' ? item.poster : item?.url
    if (!url || url === currentItem()?.url || urls.has(url)) continue
    urls.add(url)
    const image = new Image()
    warmImages.push(image)
    void prepareImage(image, url, warmLoad.signal)
  }
}

function measureNode(node) {
  disposeAnimations(node)
  const transform = node.style.transform
  node.style.transform = restTransform
  const rect = node.getBoundingClientRect()
  node.style.transform = transform || restTransform
  return rect
}

// 统一比例避免把缩略图裁切比例拉伸到原图；几何只在动画开始前读取。
function transformToRect(from, to) {
  const scale = Math.max(.01, Math.min(from.width / to.width, from.height / to.height))
  const x = from.left + from.width / 2 - (to.left + to.width / 2)
  const y = from.top + from.height / 2 - (to.top + to.height / 2)
  return `translate(${x}px, ${y}px) scale(${scale})`
}

function visibleRect(node) {
  if (!node?.isConnected) return null
  const rect = node.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth ? rect : null
}

function currentOrigin() {
  const tile = [...document.querySelectorAll('[data-media-url]')].find((node) => node.dataset.mediaUrl === currentItem()?.url && visibleRect(node))
  if (tile) return visibleRect(tile.querySelector('img') || tile)
  return currentItem()?.url === originUrl ? visibleRect(trigger) : null
}

function resetVideo() {
  releaseVideo(videoEl)
  videoEl.hidden = true
}

// 将已解码节点原子替换进画面；旧图片在准备阶段始终保留。
function commitMedia(item, node) {
  resetView()
  disposeAnimations(imageEl)
  disposeAnimations(videoEl)
  resetVideo()
  livePlaying = false
  liveBtn.hidden = true
  liveBtn.setAttribute('aria-pressed', 'false')
  node.style.transform = restTransform
  node.style.opacity = '0'
  if (item.type === 'video') {
    imageEl.hidden = true
    node.id = 'lightboxVideo'
    node.controls = true
    videoEl.replaceWith(node)
    videoEl = node
  } else {
    node.id = 'lightboxImg'
    node.alt = `第 ${index + 1} 张图片`
    node.draggable = false
    const previous = imageEl
    previous.replaceWith(node)
    imageEl = node
    previous.removeAttribute('src')
    liveBtn.hidden = !(item.live && item.motion)
    liveBtn.textContent = 'LIVE'
    layoutImage()
  }
  mediaReady = true
}

function animateImageStep(node, direction, entering) {
  return animateElement(node, entering ? { opacity: 1, transform: restTransform } : {
    opacity: 0, transform: `translate(${-direction * 14}px, 0px) scale(1)`,
  }, {
    duration: entering ? motionTiming.imageIn : motionTiming.imageOut,
    initial: entering ? { opacity: 0, transform: `translate(${direction * 14}px, 0px) scale(1)` } : undefined,
  }).finished
}

async function loadItem(targetIndex, step = 0, origin = null) {
  const token = ++switchToken
  mediaLoad?.abort()
  clearWarmImages()
  mediaLoad = new AbortController()
  const signal = mediaLoad.signal
  const valid = () => token === switchToken && !signal.aborted && !lightbox.hidden && !closing
  if (mediaReady) animateElement(activeNode(), { opacity: 1, transform: restTransform }, { duration: motionTiming.content })
  setStatus('正在加载…', true)
  const result = await prepareMedia(items[targetIndex], signal)
  if (!valid()) {
    if (result.status === 'ready') {
      if (result.node instanceof HTMLVideoElement) releaseVideo(result.node)
      else result.node.removeAttribute('src')
    }
    return
  }
  if (result.status !== 'ready') {
    requestedIndex = index
    setStatus('影像加载或解码失败，请重试。', false, () => { requestedIndex = targetIndex; void loadItem(targetIndex, step, origin) })
    return
  }
  if (step && mediaReady && !prefersReducedMotion()) {
    const outgoing = await animateImageStep(activeNode(), Math.sign(step), false)
    if (!valid() || outgoing.status !== 'finished') {
      if (result.node instanceof HTMLVideoElement) releaseVideo(result.node)
      else result.node.removeAttribute('src')
      return
    }
  }
  if (!valid()) return
  index = targetIndex
  commitMedia(currentItem(), result.node)
  setStatus()
  const node = activeNode()
  if (step) {
    animateImageStep(node, Math.sign(step), true)
  } else {
    const target = measureNode(node)
    const source = visibleRect(origin)
    const longImage = target.height > viewport.clientHeight * 2
    const initial = longImage ? restTransform : source && target.width && target.height
      ? transformToRect(source, target) : 'translate(0px, 0px) scale(.98)'
    animateElement(node, { opacity: 1, transform: restTransform }, {
      duration: longImage ? motionTiming.content : motionTiming.imageOpen,
      easing: longImage ? motionEasing.out : motionEasing.move,
      initial: { opacity: 0, transform: initial },
    })
  }
  warmAdjacent()
}

/** @param {object[]} list @param {number} startIndex @param {HTMLElement|null} source */
export function openLightbox(list, startIndex = 0, source = null) {
  if (!Array.isArray(list) || !list.length) return
  ++motionToken
  ++switchToken
  closing = false
  closePromise = null
  mediaLoad?.abort()
  clearWarmImages()
  disposeAnimations(imageEl)
  disposeAnimations(videoEl)
  resetVideo()
  imageEl.hidden = true
  mediaReady = false
  livePlaying = false
  liveBtn.hidden = true
  liveBtn.setAttribute('aria-pressed', 'false')
  items = list
  index = Math.max(0, Math.min(list.length - 1, startIndex))
  requestedIndex = index
  trigger = source instanceof Element ? source.closest('button, a') || source : null
  originUrl = currentItem().url
  modal.open({ source: trigger, focus: closeBtn })
  animatePresence(lightbox, true, { className: 'lightbox-presence', duration: motionTiming.backdrop })
  const tile = trigger?.closest('[data-media-url]')
  void loadItem(index, 0, tile?.querySelector('img') || trigger)
  prevBtn.hidden = nextBtn.hidden = items.length <= 1
}

export function closeLightbox(immediate = false) {
  if (lightbox.hidden) return Promise.resolve({ status: 'finished' })
  if (closing && !immediate) return closePromise
  const token = ++motionToken
  ++switchToken
  closing = true
  mediaLoad?.abort()
  clearWarmImages()
  videoEl.pause()
  const node = activeNode()
  const finish = () => {
    if (token !== motionToken) return { status: 'interrupted' }
    disposeAnimations(lightbox)
    resetVideo()
    imageEl.removeAttribute('src')
    imageEl.hidden = true
    resetView()
    liveBtn.hidden = true
    livePlaying = mediaReady = false
    setStatus()
    modal.finish()
    lightbox.classList.remove('lightbox-presence', 'lightbox-presence-present', 'lightbox-presence-closing')
    lightbox.style.opacity = ''
    trigger = null
    items = []
    closing = false
    return { status: 'finished' }
  }
  if (immediate || prefersReducedMotion()) return Promise.resolve(finish())
  modal.beginClose()
  const target = currentOrigin()
  const current = mediaReady ? measureNode(node) : null
  const transform = target && current?.width && current?.height && current.height <= viewport.clientHeight * 2
    ? transformToRect(target, current) : restTransform
  closePromise = Promise.all([
    mediaReady ? animateElement(node, { transform, opacity: 0 }, { duration: motionTiming.imageClose, easing: motionEasing.move }).finished : Promise.resolve(),
    animatePresence(lightbox, false, { className: 'lightbox-presence', hidden: false, duration: motionTiming.backdrop }),
  ]).then(finish)
  return closePromise
}

function move(step) {
  if (!items.length || lightbox.hidden || closing) return
  requestedIndex = (requestedIndex + step + items.length) % items.length
  stopLive()
  videoEl.pause()
  void loadItem(requestedIndex, step)
}

async function playLive() {
  const item = currentItem()
  if (closing || !mediaReady || !item?.motion) return
  const token = ++switchToken
  requestedIndex = index
  mediaLoad?.abort()
  mediaLoad = new AbortController()
  const signal = mediaLoad.signal
  setStatus('正在加载实况…', true)
  const result = await prepareMedia({ type: 'video', url: item.motion, poster: item.url }, signal)
  if (token !== switchToken || signal.aborted || closing || lightbox.hidden) {
    if (result.status === 'ready') releaseVideo(result.node)
    return
  }
  if (result.status !== 'ready') { setStatus('实况加载失败，请重试。', false, () => { void playLive() }); return }
  disposeAnimations(imageEl)
  resetView()
  resetVideo()
  const node = result.node
  node.id = 'lightboxVideo'
  node.loop = true
  node.preload = 'auto'
  node.style.transform = restTransform
  videoEl.replaceWith(node)
  videoEl = node
  imageEl.hidden = true
  livePlaying = true
  liveBtn.hidden = false
  liveBtn.textContent = 'LIVE · 循环中'
  liveBtn.setAttribute('aria-pressed', 'true')
  setStatus()
  try { await node.play() }
  catch {
    if (token === switchToken && !closing && !lightbox.hidden) { stopLive(); setStatus('浏览器无法播放此实况，请重试。', false, () => { void playLive() }) }
  }
}

function stopLive() {
  if (!livePlaying) return
  livePlaying = false
  resetVideo()
  if (currentItem()?.type === 'image') {
    imageEl.hidden = false
    imageEl.style.opacity = '1'
    imageEl.style.transform = restTransform
    liveBtn.hidden = !currentItem().live
    liveBtn.setAttribute('aria-pressed', 'false')
    liveBtn.textContent = 'LIVE'
    layoutImage()
  }
}

function togglePlayback() {
  const item = currentItem()
  if (closing || !mediaReady || !item) return
  if (item.type !== 'video' && !livePlaying) { void playLive(); return }
  if (videoEl.paused) videoEl.play().catch(() => setStatus('浏览器无法播放此视频。'))
  else videoEl.pause()
}

closeBtn.onclick = () => { void closeLightbox() }
prevBtn.onclick = () => move(-1)
nextBtn.onclick = () => move(1)
liveBtn.onclick = (event) => { event.stopPropagation(); if (livePlaying) stopLive(); else void playLive() }
retryBtn.onclick = () => retryAction?.()
stage.addEventListener('ended', (event) => { if (event.target === videoEl && !videoEl.loop) stopLive() }, true)
viewport.addEventListener('click', (event) => { if (event.target === videoEl && livePlaying) togglePlayback() })
viewport.addEventListener('dblclick', (event) => {
  if (event.target !== imageEl) return
  event.preventDefault()
  zoomAt(zoom > 1 ? 1 : 2, event.clientX, event.clientY)
})
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
  if (event.touches.length !== 2 || imageEl.hidden || closing) return
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
  if (event.target === lightbox || event.target === viewport || event.target === stage) void closeLightbox()
}
document.addEventListener('keydown', (event) => {
  if (lightbox.hidden || closing) return
  if (event.key === 'Escape') return
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); return }
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1); return }
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
