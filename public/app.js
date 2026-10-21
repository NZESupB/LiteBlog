// 前端逻辑:hash 路由 + 时间轴 / 相册 / 登录 / 账号 / 设置视图
import { attachMdToolbar, attachEmojiButton, closeEmojiPanel } from '/vendor/md-toolbar.js'
import { icon } from '/vendor/icons.js'
import { animatePresence, attachSheetMotion } from '/js/sheet-motion.js'
import { attachComposerViewport, attachInlineInputViewport } from '/js/composer-viewport.js'
import { api, streamSse, formatBytes, el, esc, setFormMessage, avatarColor, parseTime, formatTime, dateLabel } from '/js/utils.js'
import { openLightbox, closeLightbox } from '/js/lightbox.js'
import { playInlineVideo, stopInlineVideo, preloadInlineVideoPlayer } from '/js/inline-video.js'
import { isVideoFile, readVideoPoster, formatDuration } from '/js/media.js'
import { normalizeMediaFiles } from '/js/live-photo.js'
import { uploadVideo, waitForVideoUpload, cancelVideoUpload, retryVideoUpload, selectVideoVariant, getVideoUploadConfig, formatVideoElapsed, formatVideoBytes } from '/js/video-upload.js'
import { createBackupSettings } from '/js/backup-settings.js'
import { createBrowserNotifications } from '/js/browser-notifications.js'
const $ = (sel, el = document) => el.querySelector(sel)
const main = $('#main')

let site = null // { title, anniversary, privateMode, user, reactionEmojis }
const PAGE_SIZE = 20
// 表情列表由 /api/site 统一下发,本地这份仅是接口异常时的兜底
const FALLBACK_REACTION_EMOJIS = '👍 ❤️ 😂 😍 🎉 😢 😡 👏 🔥 💯 🙌 🥰 😮 🤔'.split(' ')
const reactionEmojis = () => (Array.isArray(site?.reactionEmojis) && site.reactionEmojis.length ? site.reactionEmojis : FALLBACK_REACTION_EMOJIS)
// 评论删除按钮的显隐仅是界面提示,服务端仍按 24h 窗口强校验;动态编辑则用服务端下发的 canEdit
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000
function withinEditWindow(createdAt) {
  const time = parseTime(createdAt).getTime()
  return Number.isFinite(time) && Date.now() - time <= EDIT_WINDOW_MS
}
let activePostMenu = null
let activeInlineComposerCleanup = null
let activeSettingsCleanup = null
let serviceWorkerRegistration = null
let activeUserNotificationCleanup = null
const browserNotifications = createBrowserNotifications({ api, getRegistration: () => serviceWorkerRegistration, getUser: () => site?.user })
let dayProgressTimer = null
let hasRenderedView = false
let pageTransitionToken = 0

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'notification-click') notificationTarget(event.data.postId, event.data.commentId)
  })
}

function closePostMenu(immediate = false) {
  if (!activePostMenu) return
  const current = activePostMenu
  activePostMenu = null
  current.button.setAttribute('aria-expanded', 'false')
  animatePresence(current.menu, false, { className: 'menu-presence', duration: 180, immediate })
}

document.addEventListener('click', (event) => {
  if (!activePostMenu) return
  if (!activePostMenu.menu.contains(event.target) && !activePostMenu.button.contains(event.target)) closePostMenu()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePostMenu()
})

// 下拉菜单(评论通知铃铛 / 用户菜单)的「点外部关闭」只在模块级注册一次:
// 之前在每次渲染时各自注册 document 监听,重新渲染一次就叠加一份,永不释放
// 铃铛与头像按钮各自 stopPropagation,不会走到这里,所以打开前还要显式收起另一个(见 closeDropdowns)
function closeDropdowns(except = null, immediate = false) {
  document.querySelectorAll('.dropdown:not([hidden])').forEach((drop) => {
    if (drop === except) return
    drop.parentElement?.querySelector(':scope > button')?.setAttribute('aria-expanded', 'false')
    animatePresence(drop, false, { className: 'menu-presence', duration: 180, immediate })
  })
}
document.addEventListener('click', () => closeDropdowns())

// ---------- 滚动进场动效 ----------
// 元素进入视口时补上 .in 触发上浮渐显;reduced-motion 用户由 CSS 直接跳过。
// 用 threshold 0 而非按比例:超长动态(多图)可见比例永远上不去,按比例会让它停在透明态。
const revealObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    entry.target.classList.add('in')
    revealObserver.unobserve(entry.target)
  }
}, { threshold: 0, rootMargin: '0px 0px -8% 0px' })

function reveal(node) {
  node.classList.add('reveal')
  revealObserver.observe(node)
  return node
}

function avatarNode(name, url, className = '') {
  const displayName = String(name || '?')
  const node = el(`<span class="avatar ${className}"></span>`)
  const fallback = () => {
    node.classList.remove('avatar-image')
    node.textContent = displayName[0] || '?'
    node.style.background = avatarColor(displayName)
  }
  if (url) {
    node.classList.add('avatar-image')
    const image = el(`<img src="${esc(url)}" alt="${esc(displayName)}" loading="lazy" />`)
    image.onerror = fallback
    node.appendChild(image)
  } else fallback()
  return node
}

function updateDayProgress() {
  const daysEl = $('#days')
  if (!daysEl) return
  const anniversary = site?.anniversary ? new Date(`${site.anniversary}T00:00:00`) : null
  const anniversaryTime = anniversary?.getTime()
  if (!Number.isFinite(anniversaryTime)) {
    daysEl.hidden = true
    return
  }
  const now = new Date()
  const days = Math.floor((now.getTime() - anniversaryTime) / 86400000) + 1
  if (days <= 0) {
    daysEl.hidden = true
    return
  }
  if (!daysEl.querySelector('.day-progress')) {
    daysEl.innerHTML = '<span class="day-progress" role="progressbar" aria-label="到下一天的进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="day-progress-fill" aria-hidden="true"></span><span class="day-progress-label"><strong></strong></span></span>'
  }
  $('.day-progress-label strong', daysEl).textContent = `${days}天`

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const duration = tomorrow.getTime() - today.getTime()
  const progress = duration > 0 ? Math.min(1, Math.max(0, (now.getTime() - today.getTime()) / duration)) : 0
  const percent = Math.round(progress * 100)
  const remainingMinutes = Math.max(0, Math.ceil((tomorrow.getTime() - now.getTime()) / 60000))
  const hours = Math.floor(remainingMinutes / 60)
  const minutes = remainingMinutes % 60
  const remaining = hours ? `${hours}小时${minutes}分钟` : `${minutes}分钟`
  const progressBar = $('.day-progress', daysEl)
  progressBar.style.setProperty('--day-progress', progress.toFixed(6))
  progressBar.classList.toggle('is-filled', progress >= 0.5)
  progressBar.setAttribute('aria-valuenow', String(percent))
  progressBar.setAttribute('aria-valuetext', `距离下一天还有${remaining}`)
  daysEl.hidden = false
}

function startDayProgress() {
  clearInterval(dayProgressTimer)
  dayProgressTimer = null
  updateDayProgress()
  if (site?.anniversary) dayProgressTimer = setInterval(updateDayProgress, 1000)
}

let toastTimer = null
let activeToast = null
function dismissToast(toast = activeToast, immediate = false) {
  if (!toast) return
  if (toast === activeToast) activeToast = null
  clearTimeout(toast._toastTimer)
  animatePresence(toast, false, {
    className: 'toast-presence',
    duration: 220,
    remove: true,
    immediate,
  })
}
function showToast(message, action = null) {
  dismissToast(document.querySelector('.toast'), true)
  const toast = el('<div class="toast" role="status"><span class="toast-message"></span></div>')
  $('.toast-message', toast).textContent = message
  if (action) {
    const button = el('<button type="button" class="toast-action">查看</button>')
    button.onclick = () => { action(); dismissToast(toast) }
    toast.appendChild(button)
  }
  toast.hidden = true
  document.body.appendChild(toast)
  animatePresence(toast, true, { className: 'toast-presence', duration: 220 })
  clearTimeout(toastTimer)
  toast._toastTimer = setTimeout(() => dismissToast(toast), action ? 6000 : 2600)
  toastTimer = toast._toastTimer
  activeToast = toast
}

function newDraftId() {
  return globalThis.crypto?.randomUUID?.() || `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function composeDraftKey(draftId) {
  return `compose-draft:${location.origin}:${site?.user?.id || 'guest'}:${draftId}`
}

function readComposeState(draftId) {
  try {
    const raw = localStorage.getItem(composeDraftKey(draftId))
    if (raw) return JSON.parse(raw)
    // 早期草稿没有文章 ID,只迁移到新建草稿,不能覆盖已有动态的正文。
    if (!String(draftId).startsWith('post-')) {
      const legacy = sessionStorage.getItem(`compose-draft:${site?.user?.id || 'guest'}`)
      return legacy ? { content: legacy } : null
    }
    return null
  } catch { return null }
}

function saveComposeState(draftId, state) {
  try {
    localStorage.setItem(composeDraftKey(draftId), JSON.stringify({ ...state, savedAt: new Date().toISOString() }))
    document.querySelector('.draft-save-state')?.replaceChildren(document.createTextNode('已保存到此浏览器'))
  } catch {
    document.querySelector('.draft-save-state')?.replaceChildren(document.createTextNode('浏览器缓存不可用'))
  }
}

function clearComposeState(draftId) {
  try {
    localStorage.removeItem(composeDraftKey(draftId))
    sessionStorage.removeItem(`compose-draft:${site?.user?.id || 'guest'}`)
  } catch {}
}

let draftFileDbPromise = null
function draftFileDb() {
  if (draftFileDbPromise) return draftFileDbPromise
  draftFileDbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { resolve(null); return }
    const request = indexedDB.open('couple-blog-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(() => null)
  return draftFileDbPromise
}

async function saveDraftFile(draftId, file) {
  const db = await draftFileDb()
  if (!db || !file?._id) return
  await new Promise((resolve) => {
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put({ key: `${draftId}:${file._id}`, draftId, id: file._id, name: file.name, type: file.type, blob: file })
    tx.oncomplete = resolve; tx.onerror = resolve
  })
}

async function loadDraftFiles(draftId) {
  const db = await draftFileDb()
  if (!db) return []
  return new Promise((resolve) => {
    const tx = db.transaction('files', 'readonly')
    const request = tx.objectStore('files').getAll()
    request.onsuccess = () => resolve(request.result.filter((row) => row.draftId === draftId).map((row) => Object.assign(new File([row.blob], row.name, { type: row.type }), { _id: row.id })))
    request.onerror = () => resolve([])
  })
}

async function clearDraftFiles(draftId) {
  const db = await draftFileDb()
  if (!db) return
  await new Promise((resolve) => {
    const tx = db.transaction('files', 'readwrite')
    const store = tx.objectStore('files')
    const request = store.getAllKeys()
    request.onsuccess = () => {
      for (const key of request.result) if (String(key).startsWith(`${draftId}:`)) store.delete(key)
    }
    tx.oncomplete = resolve; tx.onerror = resolve
  })
}

async function removeDraftFile(draftId, fileId) {
  const db = await draftFileDb()
  if (!db || !fileId) return
  await new Promise((resolve) => {
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').delete(`${draftId}:${fileId}`)
    tx.oncomplete = resolve; tx.onerror = resolve
  })
}

let activeComposerModal = null
function openComposerModal(post = null, source = null) {
  if (!site?.user) { location.hash = '#/login'; return }
  if (activeComposerModal) return
  const trigger = source instanceof HTMLElement ? source : document.activeElement instanceof HTMLElement ? document.activeElement : null
  const scrollY = window.scrollY
  const draftId = post ? `post-${post.id}` : (() => {
    const key = `compose-draft-id:${location.origin}:${site.user.id}`
    try {
      let id = localStorage.getItem(key)
      if (!id) { id = newDraftId(); localStorage.setItem(key, id) }
      return id
    } catch { return newDraftId() }
  })()
  let closeModal = () => {}
  const overlay = el(`<div class="composer-overlay" role="dialog" aria-modal="true" aria-label="${post ? '编辑日常' : '写日常'}">
    <div class="composer-dialog"><button class="composer-grab" type="button" aria-label="收起写作面板，也可向下拖动"></button><button class="composer-close" type="button" aria-label="关闭">×</button><div class="composer-body"></div></div>
  </div>`)
  const body = $('.composer-body', overlay)
  const card = createComposer(post, draftId, async (result = {}) => {
    closeModal(true)
    if (post) {
      clearComposeState(draftId)
      await clearDraftFiles(draftId)
      showToast('动态已保存')
      renderTimeline()
    } else {
      clearComposeState(draftId)
      await clearDraftFiles(draftId)
      try { localStorage.removeItem(`compose-draft-id:${location.origin}:${site.user.id}`) } catch {}
      if (!location.hash || location.hash === '#/') renderTimeline()
      showToast('发布成功', () => { location.hash = `#/post/${result.id}` })
    }
  }, () => closeModal())
  body.appendChild(card)
  const closeButton = $('.composer-close', overlay)
  const grabHandle = $('.composer-grab', overlay)
  const onKeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return }
    if (event.key !== 'Tab') return
    const focusable = [...overlay.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((node) => !node.disabled && node.getClientRects().length > 0)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  let motion = null
  let disposeViewport = null
  const background = [main, $('.site-header'), $('.mobile-nav')].map((node) => ({ node, inert: node.inert }))
  const finishClose = () => {
    if (!overlay.isConnected) return
    motion?.dispose()
    disposeViewport?.()
    card.dispose?.()
    document.removeEventListener('keydown', onKeydown)
    for (const { node, inert } of background) node.inert = inert
    document.body.classList.remove('modal-open')
    overlay.remove()
    activeComposerModal = null
    window.scrollTo({ top: scrollY, behavior: 'instant' })
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  }
  closeModal = (immediate = false) => immediate === true ? finishClose() : motion?.close()
  closeButton.onclick = () => closeModal()
  overlay.onclick = (event) => { if (event.target === overlay) closeModal() }
  document.body.appendChild(overlay)
  const dialog = $('.composer-dialog', overlay)
  // 触发元素的矩形先量好:桌面端拿它当缩放原点,移动端拿它当容器变形的起点。
  // 必须在 body 加 modal-open(隐藏滚动条)之前量,否则坐标会偏。
  const triggerRect = trigger ? trigger.getBoundingClientRect() : null
  if (triggerRect) {
    const dialogRect = dialog.getBoundingClientRect()
    if (dialogRect.width && dialogRect.height) {
      dialog.style.transformOrigin = `${triggerRect.left + triggerRect.width / 2 - dialogRect.left}px ${triggerRect.top + triggerRect.height / 2 - dialogRect.top}px`
    }
  }
  document.body.classList.add('modal-open')
  for (const { node } of background) node.inert = true
  activeComposerModal = { close: closeModal, overlay }
  disposeViewport = attachComposerViewport(overlay)
  motion = attachSheetMotion(dialog, overlay, grabHandle, finishClose, { origin: trigger })
  document.addEventListener('keydown', onKeydown)
  requestAnimationFrame(() => { if (overlay.isConnected) $('textarea', card)?.focus({ preventScroll: true }) })
}

function installToTop() {
  const sentinel = el('<div class="top-sentinel" aria-hidden="true"></div>')
  main.prepend(sentinel)
  const button = el(`<button class="to-top" type="button" title="回到顶部" aria-label="回到顶部" hidden>${icon('arrow-up')}</button>`)
  button.onclick = () => window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  main.appendChild(button)
  observeViewport(sentinel, (visible) => (button.hidden = visible))
  return button
}

// 时间轴的两个视口观察器:哨兵进入视口即自动续页、列表顶部离开视口即显示回到顶部。
// 与 revealObserver 分开:那个观察到一次就 unobserve,不能复用于需要反复触发的场景。
let timelineObservers = []

function observeViewport(target, onChange, options) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) onChange(entry.isIntersecting)
  }, options)
  observer.observe(target)
  timelineObservers.push(observer)
}

// 桌面端:页面往下滚、标题里的「写日常」离开视口后,入口交给顶栏那颗按钮,
// 不必滚回顶部才能写。窄屏不做(顶栏那颗被 CSS 藏起来,入口在 Dock)。
function watchHeaderWrite(source) {
  const slot = $('#headerWriteSlot')
  const headerWrite = $('#headerWrite')
  if (!slot || !headerWrite) return
  headerWrite.onclick = (event) => openComposerModal(null, event.currentTarget)
  // 顶栏是 sticky 的:标题那颗被顶栏盖住(或滚出视口)时,就把入口交出去
  const headerHeight = Math.round($('.site-header').getBoundingClientRect().height)
  observeViewport(source, (visible) => {
    animatePresence(slot, !visible, { className: 'header-write-presence', duration: 240 })
  }, { rootMargin: `-${headerHeight + 8}px 0px 0px 0px` })
}

// 切换视图即清空主区域;未进过视口的观察目标随之作废,避免观察表越积越长
function clearMain() {
  activeSettingsCleanup?.()
  activeSettingsCleanup = null
  activeComposerModal?.close?.(true)
  activeInlineComposerCleanup?.()
  activeInlineComposerCleanup = null
  closeEmojiPanel(true)
  stopInlineVideo()
  closeLightbox(true)
  closePostMenu(true)
  closeDropdowns(null, true)
  revealObserver.disconnect()
  for (const observer of timelineObservers) observer.disconnect()
  timelineObservers = []
  // 顶栏的写入口不在 main 里,切页时要显式收起,否则会留在别的页面上
  animatePresence($('#headerWriteSlot'), false, { className: 'header-write-presence', immediate: true })
  main.innerHTML = ''
  main.className = 'container'
  if (hasRenderedView) {
    main.classList.add('page-enter')
    const token = ++pageTransitionToken
    setTimeout(() => { if (token === pageTransitionToken) main.classList.remove('page-enter') }, 520)
  }
  hasRenderedView = true
}

function emptyJournal(title, description, cover = false) {
  const empty = el(`<div class="journal-empty">
    ${cover ? `<div class="journal-cover"><img src="${esc(cover)}" alt="" /></div>` : ''}
    <span class="empty-symbol">${icon('heart')}</span>
    <h3>${esc(title)}</h3><p>${esc(description)}</p>
  </div>`)
  if (!site.user) empty.appendChild(el('<a class="btn" href="#/login">登录，写下第一篇</a>'))
  else if (cover) {
    const write = el('<button class="btn-ghost" type="button">去记录今天</button>')
    write.onclick = (event) => openComposerModal(null, event.currentTarget)
    empty.appendChild(write)
  }
  return empty
}

// ---------- 图片压缩(canvas,最长边 1600px) ----------

// HEIC/HEIF(canvas 无法直接解码):用 heic2any(vendor)转成可压缩的 JPEG
// heic2any 是 UMD 包,以 ES Module 方式引入时不导出任何具名成员,只会把函数挂到 window
let heic2anyLoading = null
function loadHeic2any() {
  if (typeof window.heic2any === 'function') return Promise.resolve(window.heic2any)
  if (heic2anyLoading) return heic2anyLoading
  heic2anyLoading = import('/vendor/heic2any.min.js')
    .then(() => {
      if (typeof window.heic2any !== 'function') throw new Error('HEIC 解码库未正确加载')
      return window.heic2any
    })
    .catch(() => { heic2anyLoading = null; throw new Error('HEIC 解码库加载失败') })
  return heic2anyLoading
}

async function decodeImage(file) {
  try {
    const bitmap = await createImageBitmap(file)
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  } catch {
    const url = URL.createObjectURL(file), image = new Image()
    try {
      image.src = url
      await image.decode()
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片没有有效尺寸')
      return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }
    } catch { URL.revokeObjectURL(url); throw new Error('图片无法解码，请重新选择原件或使用 JPEG/PNG') }
  }
}
async function imageJpeg(file, decoded, maxEdge = Infinity, quality = 0.9) {
  const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(decoded.width * scale)); canvas.height = Math.max(1, Math.round(decoded.height * scale))
  canvas.getContext('2d').drawImage(decoded.image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob?.size) throw new Error('图片转换失败，请使用 JPEG/PNG')
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
}
async function normalizeHeic(file) {
  if (!/image\/hei[cf]/i.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) return file
  try {
    const decoded = await decodeImage(file)
    try { return await imageJpeg(file, decoded) } finally { decoded.close() }
  } catch {
    const convert = await loadHeic2any()
    const result = await convert({ blob: file, toType: 'image/jpeg', quality: 0.9 })
    const blob = Array.isArray(result) ? result[0] : result
    if (!blob?.size) throw new Error('HEIC 主图转换失败，请重新选择原件或使用 JPEG/PNG')
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  }
}
async function compressImage(file) {
  const decoded = await decodeImage(file)
  try {
    const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)
    if (supported && (file.type === 'image/gif' || file.size < 300 * 1024)) return file
    const compressed = await imageJpeg(file, decoded, 1600, 0.85)
    return supported && compressed.size >= file.size ? file : compressed
  } finally { decoded.close() }
}

// ---------- 发布 / 编辑组件 ----------

// 编辑框高度拖拽:自绘手柄替代原生 resize(原生手柄在无边框样式下几乎不可见,且触屏不可用)
const EDITOR_MIN_HEIGHT = 88
function attachEditorResize(handle, textarea) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = textarea.getBoundingClientRect().height
    const maxHeight = Math.max(EDITOR_MIN_HEIGHT, window.innerHeight * 0.75)
    const onMove = (ev) => {
      const next = Math.min(maxHeight, Math.max(EDITOR_MIN_HEIGHT, startHeight + ev.clientY - startY))
      textarea.style.height = `${next}px`
    }
    const onEnd = () => {
      handle.releasePointerCapture(e.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
    }
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  })
}

// post 传 null 表示新建;编辑时带已有图片(keep 未勾除的 id)
function createComposer(post, draftId, onDone, onCancel) {
  const card = el(`
    <div class="card compose">
      <div class="compose-heading"><span>${post ? '编辑这段日常' : '今天，有什么想记住的？'}</span><span class="draft-save-state" aria-live="polite">草稿未发布</span></div>
      <div class="md-toolbar" role="toolbar" aria-label="Markdown 格式">
        <button data-md="bold" title="加粗 (⌘B)">${icon('bold')}</button>
        <button data-md="italic" title="斜体 (⌘I)">${icon('italic')}</button>
        <button data-md="strikethrough" title="删除线">${icon('strikethrough')}</button>
        <span class="md-sep"></span>
        <button data-md="heading" title="标题">${icon('heading')}</button>
        <button data-md="quote" title="引用">${icon('quote')}</button>
        <button data-md="code-inline" title="行内代码">${icon('code')}</button>
        <button data-md="code-block" title="代码块">${icon('square-code')}</button>
        <span class="md-sep"></span>
        <button data-md="list-ul" title="无序列表">${icon('list')}</button>
        <button data-md="list-ol" title="有序列表">${icon('list-ordered')}</button>
        <button data-md="tasklist" title="任务列表">${icon('list-checks')}</button>
        <button data-md="link" title="链接 (⌘K)">${icon('link')}</button>
        <span class="md-sep"></span>
        <button data-md="emoji" title="表情" type="button">${icon('smile')}</button>
        <span class="ai-tools" role="group" aria-label="AI 工具">
          <button class="md-polish" title="AI 优化正文" type="button">${icon('sparkles')}<span>AI 优化</span></button>
          <button class="md-image" title="根据正文生成配图" type="button">${icon('image')}<span>AI 配图</span></button>
        </span>
      </div>
      <div class="editor-box">
        <textarea aria-label="动态正文" placeholder="一顿晚餐、一场散步，或是突然想说的话…"></textarea>
        <div class="editor-resize" title="拖动调整编辑框高度" role="separator" aria-label="拖动调整编辑框高度"></div>
      </div>
      <div class="ai-compare" hidden>
        <div class="ai-compare-head">
          <span class="ai-compare-title">${icon('sparkles')}<span>AI 优化对照</span></span>
          <span class="ai-compare-status"></span>
          <button class="ai-compare-close" type="button" aria-label="关闭对照">×</button>
        </div>
        <div class="ai-compare-body">
          <section class="ai-pane"><h4>原文</h4><div class="ai-pane-text ai-origin"></div></section>
          <section class="ai-pane"><h4>AI 优化</h4><div class="ai-pane-text ai-result"></div></section>
        </div>
        <div class="ai-compare-actions">
          <button class="btn-ghost ai-retry" type="button">重新生成</button>
          <span class="spacer"></span>
          <button class="btn-ghost ai-discard" type="button">保留原文</button>
          <button class="btn ai-adopt" type="button">采用优化</button>
        </div>
      </div>
      <div class="image-job-panel" hidden>
        <div class="image-job-head"><span class="image-job-title">${icon('image')}<span>AI 配图</span></span><span class="image-job-status" aria-live="polite"></span></div>
        <div class="image-job-preview"></div>
        <div class="image-job-actions">
          <button class="btn-ghost image-job-retry" type="button" hidden>重新生成</button>
          <button class="btn-ghost image-job-cancel" type="button">取消任务</button>
          <button class="btn image-job-use" type="button" hidden>使用这张图</button>
        </div>
      </div>
      <div class="preview-grid"></div>
      <p class="storage-hint live-photo-help">实况照片请选择原件；iPhone 请同时选择照片和配对 MOV。系统只提供静态图时，无法恢复动态内容。</p>
      <div class="form-error"></div>
      <div class="compose-actions">
        <button class="btn-ghost pick" type="button" title="从相册选择照片或视频" aria-label="从相册选择照片或视频">${icon('image')}</button>
        <button class="btn-ghost camera" type="button" title="调用相机拍照" aria-label="调用相机拍照">${icon('camera')}</button>
        <div class="public-opts" ${site.privateMode ? '' : 'hidden'}>
          <span class="public-opts-tip">${icon('lock')}<span>访客可见</span></span>
          <label class="public-chip"><input type="checkbox" name="publicText" ${post && post.public_text ? 'checked' : ''} /><span>正文</span></label>
          <label class="public-chip"><input type="checkbox" name="publicImages" ${post && post.public_images ? 'checked' : ''} /><span>图片</span></label>
        </div>
        <span class="spacer"></span>
        ${post ? '<button class="btn-ghost cancel">取消</button>' : '<button class="btn-ghost discard-draft" type="button">丢弃草稿</button>'}
        <button class="btn submit">${post ? '保存' : '发布'}</button>
      </div>
      <input class="album-input" type="file" accept="image/*,video/*,.heic,.heif,.avif,.mov,.mp4" multiple hidden />
      <input class="camera-input" type="file" accept="image/*" capture="environment" hidden />
    </div>`)
  const textarea = $('textarea', card)
  // 使用即时提示替代浏览器不可配置延迟的 title,同时保留无障碍名称。
  card.querySelectorAll('button[title]').forEach((button) => {
    button.dataset.tooltip = button.title
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title)
    button.removeAttribute('title')
  })
  attachMdToolbar($('.md-toolbar', card), textarea)
  attachEditorResize($('.editor-resize', card), textarea)
  const previews = $('.preview-grid', card)
  const fileInput = $('.album-input', card)
  const cameraInput = $('.camera-input', card)
  const errorLine = $('.form-error', card)
  const submitBtn = $('.submit', card)
  const polishBtn = $('.md-polish', card)
  const imageBtn = $('.md-image', card)
  const imagePanel = $('.image-job-panel', card)
  const imageStatus = $('.image-job-status', card)
  const imagePreview = $('.image-job-preview', card)
  const imageRetry = $('.image-job-retry', card)
  const imageCancel = $('.image-job-cancel', card)
  const imageUse = $('.image-job-use', card)

  // AI 优化:后端代理流式返回(凭据服务端保管),结果与原文并排展示,由用户决定是否采用
  const compare = $('.ai-compare', card)
  const originPane = $('.ai-origin', card)
  const resultPane = $('.ai-result', card)
  const statusEl = $('.ai-compare-status', card)
  const adoptBtn = $('.ai-adopt', card)
  const retryBtn = $('.ai-retry', card)
  const discardBtn = $('.ai-discard', card)
  let polishAbort = null
  let polishResult = ''

  function setPolishState(streaming) {
    statusEl.dataset.state = streaming ? 'running' : ''
    resultPane.classList.toggle('streaming', streaming)
    polishBtn.disabled = streaming
    $('span', polishBtn).textContent = streaming ? '优化中…' : 'AI 优化'
    adoptBtn.disabled = streaming || !polishResult.trim()
    retryBtn.disabled = streaming
    discardBtn.textContent = streaming ? '取消' : '保留原文'
  }

  function closeCompare() {
    polishAbort?.abort()
    polishAbort = null
    animatePresence(compare, false, { className: 'panel-presence', duration: 200 })
    setPolishState(false)
  }

  async function runPolish() {
    const text = textarea.value.trim()
    if (!text) { errorLine.textContent = '先写点内容再优化'; return }
    errorLine.textContent = ''
    originPane.textContent = text
    resultPane.textContent = ''
    polishResult = ''
    animatePresence(compare, true, { className: 'panel-presence', duration: 200 })
    polishAbort = new AbortController()
    setPolishState(true)
    // 思考模型会先产出思维链,正文可能十几秒后才有。这段时间用秒数/思考字数报进度,
    // 否则面板一片空白,看起来像是卡住了。
    const startedAt = Date.now()
    let thinkingChars = 0
    let gotContent = false
    const tick = () => {
      if (gotContent) return
      const seconds = Math.floor((Date.now() - startedAt) / 1000)
      statusEl.textContent = thinkingChars ? `思考中…（${thinkingChars} 字）` : `思考中…${seconds}s`
    }
    tick()
    const ticker = setInterval(tick, 500)
    try {
      await streamSse('/api/llm/polish', { text }, (evt) => {
        // 思维链只用来表示「还在思考」,不并入结果也不是正文
        if (evt.reasoning) { thinkingChars += evt.reasoning.length; tick(); return }
        if (!evt.delta) return
        if (!gotContent) { gotContent = true; statusEl.textContent = '生成中…' }
        polishResult += evt.delta
        resultPane.textContent = polishResult
        resultPane.scrollTop = resultPane.scrollHeight
      }, polishAbort.signal)
      statusEl.textContent = polishResult.trim() ? '已完成,可对照后决定是否采用' : 'AI 未返回有效结果'
    } catch (e) {
      if (e.name === 'AbortError') return // 取消由 closeCompare 收尾
      if (e.code === 'LLM_NOT_CONFIGURED') {
        animatePresence(compare, false, { className: 'panel-presence', duration: 200 })
        location.hash = '#/settings'
        return
      }
      statusEl.textContent = ''
      errorLine.textContent = e.message
      if (!polishResult) animatePresence(compare, false, { className: 'panel-presence', duration: 200 })
    } finally {
      clearInterval(ticker)
      polishAbort = null
      setPolishState(false)
    }
  }

  polishBtn.onclick = runPolish
  retryBtn.onclick = runPolish
  $('.ai-compare-close', card).onclick = closeCompare
  discardBtn.onclick = closeCompare
  adoptBtn.onclick = () => {
    const adopted = polishResult.trim()
    if (!adopted) return
    textarea.value = adopted
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    closeCompare()
    textarea.focus()
  }
  setPolishState(false)

  if (post) textarea.value = post.content
  const keepImages = post ? post.images.map((img) => ({ ...img })) : [] // 保留的已有图片(已就绪,不显示处理动画)
  const newFiles = [] // 新增文件,含 _status: processing/uploading/done/error
  const videoControllers = new Map()
  const parseControllers = new Set()
  const videoResults = el('<div class="storage-hint" aria-live="polite" hidden></div>')
  previews.insertAdjacentElement('afterend', videoResults)
  const savedDraft = readComposeState(draftId) || {}
  let imageTask = null
  let imageJobId = savedDraft.imageJobId || ''
  let imagePollTimer = null
  let disposed = false
  let restoringMedia = true, mediaRestoreError = ''
  const draftState = () => ({
    content: textarea.value,
    publicText: $('[name=publicText]', card)?.checked ?? false,
    publicImages: $('[name=publicImages]', card)?.checked ?? false,
    files: newFiles.filter((file) => !file._parsing).map((file) => ({
      id: file._id, name: file.name || '', type: file.type || '', status: file._status,
      filename: file._name || '', jobId: file._jobId || '',
      kind: file._kind || 'image', poster: file._poster || '', duration: file._duration || null,
      motion: file._motion?._name || '', motionStatus: file._motion?._status || '',
      videoJobId: file._videoJobId || '', videoResult: file._videoResult || null,
      clientUploadId: file._clientUploadId || '', fingerprint: file._fingerprint || '',
      motionJobId: file._motion?._videoJobId || '', motionResult: file._motion?._videoResult || null,
      motionClientUploadId: file._motion?._clientUploadId || '', motionFingerprint: file._motion?._fingerprint || '',
      source: file._source || null, warnings: file._warnings || [], needsReview: Boolean(file._needsReview),
      motionName: file._motion?.name || '', error: file._errMsg || '',
    })),
    keep: keepImages.map((image) => image.id),
    imageJobId: imageTask?.id || savedDraft.imageJobId || '',
  })
  const persistDraft = () => { if (!disposed && !restoringMedia && !mediaRestoreError) saveComposeState(draftId, draftState()) }
  window.addEventListener('pagehide', persistDraft)
  const savedKeep = new Set(Array.isArray(savedDraft.keep) ? savedDraft.keep : keepImages.map((image) => image.id))
  if (post) {
    for (let i = keepImages.length - 1; i >= 0; i--) if (!savedKeep.has(keepImages[i].id)) keepImages.splice(i, 1)
  }
  textarea.value = typeof savedDraft.content === 'string' ? savedDraft.content : (post ? post.content : '')
  for (const name of ['publicText', 'publicImages']) {
    const input = $(`[name=${name}]`, card)
    if (input && typeof savedDraft[name] === 'boolean') input.checked = savedDraft[name]
    input?.addEventListener('change', persistDraft)
  }
  textarea.addEventListener('input', persistDraft)
  const draftReady = api('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: draftId, postId: post?.id || null }) }).catch(() => null)

  // 原视频不写入 IndexedDB；已完整接收的视频通过任务 ID 恢复后台轮询。
  const restoreReady = (async () => {
    await draftReady
    if (disposed) return
    const snapshot = await api(`/api/drafts/${encodeURIComponent(draftId)}`)
    if (disposed) return
    const serverJobs = new Map((snapshot.videoJobs || []).map((job) => [job.uploadId, job]))
    // 原照片 blob 与已上传封面通过同一个媒体 ID 对账。
    const savedFiles = Array.isArray(savedDraft.files) ? savedDraft.files : []
    function restoreMotion(file, saved) {
      if (!saved?.motion && !saved?.motionJobId && !saved?.motionStatus) return
      file._motion = { _id: newDraftId(), name: '实况视频', _status: saved.motion ? 'done' : 'uploading', _name: saved.motion || '', _videoJobId: saved.motionJobId || '', _videoResult: saved.motionResult || null }
      file._motion._parent = file
      file._motion.name = saved.motionName || '实况视频'
      file._motion._clientUploadId = saved.motionClientUploadId || ''; file._motion._fingerprint = saved.motionFingerprint || ''
      const state = serverJobs.get(saved.motionJobId)
      if (state?.status === 'done') applyVideoResult(file._motion, state, false)
      else if (saved.motionJobId && (!saved.motion || state)) runVideoTask(file._motion, null, false)
      else if (!saved.motion) { file._motion._status = 'error'; file._motion._needsFile = true; file._motion._errMsg = '选择原始配对视频继续上传' }
    }
    for (const saved of savedFiles) {
      const kind = saved.kind || 'image'
      const thumb = kind === 'video' ? saved.poster : saved.filename
      const file = {
        _id: saved.id || newDraftId(), _name: saved.filename || '', _status: saved.filename ? 'done' : kind === 'video' ? 'uploading' : 'error', _jobId: saved.jobId || '',
        name: saved.name, type: saved.type, _kind: kind, _poster: saved.poster || '', _duration: saved.duration || null,
        _videoJobId: saved.videoJobId || '', _videoResult: saved.videoResult || null,
        _clientUploadId: saved.clientUploadId || '', _fingerprint: saved.fingerprint || '',
        _source: saved.source || null, _warnings: saved.warnings || [], _needsReview: Boolean(saved.needsReview), _errMsg: saved.error || (saved.filename ? '' : '请重新选择原始照片继续处理'),
        _url: thumb ? `/api/drafts/${encodeURIComponent(draftId)}/preview/${encodeURIComponent(thumb)}` : '',
      }
      newFiles.push(file)
      restoreMotion(file, saved)
      if (kind === 'video') {
        const state = serverJobs.get(saved.videoJobId)
        if (state?.status === 'done') applyVideoResult(file, state, true)
        else if (saved.videoJobId && (!saved.filename || state)) runVideoTask(file, null, true)
        else if (!saved.filename) { file._status = 'error'; file._needsFile = true; file._errMsg = '选择原始视频继续上传' }
      }
    }
    const restoredJobs = new Set(newFiles.flatMap((file) => [file._videoJobId, file._motion?._videoJobId]).filter(Boolean))
    for (const state of serverJobs.values()) {
      if (!state.needsPoster || restoredJobs.has(state.uploadId) || state.status === 'cancelled'
        || keepImages.some((image) => image.filename === state.filename)) continue
      const file = { _id: newDraftId(), _kind: 'video', _videoJobId: state.uploadId, name: state.name || '视频', _status: 'uploading' }
      newFiles.push(file)
      if (state.status === 'done') applyVideoResult(file, state, true)
      else runVideoTask(file, null, true)
    }
    const blobs = await loadDraftFiles(draftId)
    if (disposed) return
    for (const file of blobs) {
      const restored = newFiles.find((item) => item._id === file._id)
      if (restored?._name) {
        restored._originalFile = file
        if (restored._motion?._needsFile && restored._source?.pairing === 'embedded') resumeMotionFromFile(restored, file)
        continue
      }
      const saved = savedFiles.find((item) => item.id === file._id)
      const [group] = await normalizeMediaFiles([file])
      if (disposed) return
      const item = restored || file
      item._originalFile = file; item._uploadStill = group.still; item._source = saved?.source || group.source
      item._warnings = saved?.warnings || group.warnings; item._needsReview = saved?.needsReview ?? group.warnings.some((w) => w.blocking)
      if (!restored) { newFiles.push(item); restoreMotion(item, saved) }
      if (group.motion && !item._motion && item._source?.pairing !== 'static') item._motion = makeMotion(item, group.motion)
      processFile(item)
      if (group.motion && item._motion && (!item._motion._videoJobId || item._motion._needsFile)) runVideoTask(item._motion, group.motion, false)
    }
    renderPreviews()
    updatePublishGuard()
    persistDraft()
  })().catch((error) => { mediaRestoreError = error.message || '媒体状态读取失败'; if (!disposed) errorLine.textContent = `恢复草稿失败：${mediaRestoreError}` })
    .finally(() => { restoringMedia = false; if (!disposed) { updatePublishGuard(); persistDraft() } })

  function formatElapsed(startedAt) {
    const start = startedAt ? parseTime(startedAt).getTime() : Date.now()
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000))
    return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`
  }

  function renderImageTask(task) {
    if (!task || disposed) return
    imageJobId = task.id
    imagePanel.hidden = false
    const active = ['queued', 'running', 'uploading'].includes(task.status)
    const labels = { queued: '已排队', running: '正在生成', uploading: '正在保存到 WebDAV', succeeded: '已完成', failed: '生成失败', cancelled: '已取消' }
    imageStatus.textContent = active
      ? `${labels[task.status] || task.status} · 已等待 ${formatElapsed(task.createdAt)} · 通常需要 60 秒以上`
      : `${labels[task.status] || task.status}${task.error ? `：${task.error}` : ''}`
    imageBtn.disabled = active
    imageRetry.hidden = !['failed', 'cancelled'].includes(task.status)
    imageRetry.disabled = active
    const adopted = newFiles.some((file) => file._jobId === task.id)
    imageUse.hidden = task.status !== 'succeeded' || adopted
    imageCancel.hidden = !active && (task.status !== 'succeeded' || adopted)
    imageCancel.textContent = active ? '取消任务' : '不使用'
    if (task.status === 'succeeded' && task.previewUrl) {
      imagePreview.innerHTML = `<img src="${esc(task.previewUrl)}" alt="AI 生成的日记配图" />`
    } else if (!active && task.status !== 'failed') {
      imagePreview.innerHTML = ''
    }
    if (active) {
      clearInterval(imagePollTimer)
      imagePollTimer = setInterval(() => refreshImageTask(task.id), 3000)
    } else {
      clearInterval(imagePollTimer)
      imagePollTimer = null
    }
    persistDraft()
    updatePublishGuard()
  }

  async function refreshImageTask(id) {
    if (disposed) return
    try {
      const result = await api(`/api/image-jobs/${encodeURIComponent(id)}`)
      if (disposed) {
        if (result.task?.id && !newFiles.some((file) => file._jobId === result.task.id)) {
          api(`/api/image-jobs/${encodeURIComponent(result.task.id)}`, { method: 'DELETE' }).catch(() => {})
        }
        return
      }
      imageTask = result.task
      renderImageTask(imageTask)
    } catch (error) {
      imageStatus.textContent = error.message
    }
  }

  async function startImageJob() {
    if (disposed) return
    const text = textarea.value.trim()
    if (!text) { errorLine.textContent = '先写点内容再生成配图'; return }
    errorLine.textContent = ''
    imagePanel.hidden = false
    imageStatus.textContent = '正在提交任务…'
    imageBtn.disabled = true
    imageCancel.hidden = true
    imageRetry.hidden = true
    imageUse.hidden = true
    try {
      const result = await api('/api/image-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, text }),
      })
      if (disposed) {
        if (result.task?.id) api(`/api/image-jobs/${encodeURIComponent(result.task.id)}`, { method: 'DELETE' }).catch(() => {})
        return
      }
      imageTask = result.task
      renderImageTask(imageTask)
    } catch (error) {
      imageBtn.disabled = false
      imageStatus.textContent = ''
      errorLine.textContent = error.message
    }
  }

  async function retryImageJob() {
    if (disposed) return
    if (!imageTask?.id) return startImageJob()
    imageRetry.disabled = true
    try {
      const result = await api(`/api/image-jobs/${encodeURIComponent(imageTask.id)}/retry`, { method: 'POST' })
      if (disposed) {
        if (result.task?.id) api(`/api/image-jobs/${encodeURIComponent(result.task.id)}`, { method: 'DELETE' }).catch(() => {})
        return
      }
      imageTask = result.task
      renderImageTask(imageTask)
    } catch (error) {
      imageRetry.disabled = false
      imageStatus.textContent = error.message
    }
  }

  imageBtn.onclick = startImageJob
  imageRetry.onclick = retryImageJob
  imageCancel.onclick = async () => {
    if (!imageTask?.id) return
    await api(`/api/image-jobs/${encodeURIComponent(imageTask.id)}`, { method: 'DELETE' }).catch(() => {})
    await refreshImageTask(imageTask.id)
  }
  imageUse.onclick = () => {
    if (!imageTask || imageTask.status !== 'succeeded' || newFiles.some((file) => file._jobId === imageTask.id)) return
    newFiles.push({ _id: newDraftId(), _jobId: imageTask.id, _name: imageTask.filename, _url: imageTask.previewUrl, _status: 'done', name: 'AI 配图', type: imageTask.mime || 'image/png' })
    imageUse.hidden = true
    imageStatus.textContent = '已加入图片，发布时会一起保存'
    renderPreviews()
    updatePublishGuard()
    persistDraft()
  }

  if (savedDraft.imageJobId) refreshImageTask(savedDraft.imageJobId)

  const dispose = () => {
    if (disposed) return
    window.removeEventListener('pagehide', persistDraft)
    disposed = true
    clearInterval(imagePollTimer)
    imagePollTimer = null
    polishAbort?.abort()
    polishAbort = null
    for (const controller of parseControllers) controller.abort()
    parseControllers.clear()
    for (const controller of videoControllers.values()) controller.abort()
    videoControllers.clear()
    for (const item of newFiles) for (const url of [item._url, item._posterUrl]) if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    // 关闭编辑器时，未加入发布内容的 AI 结果没有保留价值；运行中的任务也一并取消。
    if (imageJobId && !newFiles.some((file) => file._jobId === imageJobId)) {
      api(`/api/image-jobs/${encodeURIComponent(imageJobId)}`, { method: 'DELETE' }).catch(() => {})
    }
  }
  card.dispose = dispose

  const STATUS_TEXT = { processing: '处理中', uploading: '上传中', generating: '生成中' }


  function applyVideoResult(item, result, needsPoster) {
    item._name = result.filename
    item._duration = result.duration
    item._videoResult = result
    if (needsPoster && result.poster) {
      for (const url of [item._url, item._posterUrl]) if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
      item._poster = result.poster
      item._posterUrl = ''
      item._url = `/api/drafts/${encodeURIComponent(draftId)}/preview/${encodeURIComponent(result.poster)}`
    }
    item._status = 'done'
    item._progress = null
    item._needsFile = false; item._canRetry = false; item._errMsg = ''
  }
  async function runVideoTask(item, source, needsPoster) {
    if (disposed || item._removed || videoControllers.has(item)) return
    const controller = new AbortController()
    videoControllers.set(item, controller)
    item._status = 'uploading'
    item._needsFile = false; item._canRetry = false; item._errMsg = ''
    let lastPaint = 0
    const onState = (state) => {
      if (item._removed && state.uploadId) { cancelVideoUpload(state.uploadId).catch((error) => { if (!disposed) errorLine.textContent = `取消视频失败：${error.message}` }); return }
      if (disposed || item._removed) return
      const newId = state.uploadId && item._videoJobId !== state.uploadId
      if (state.uploadId) item._videoJobId = state.uploadId
      const identityChanged = (state.clientUploadId && state.clientUploadId !== item._clientUploadId) || (state.fingerprint && state.fingerprint !== item._fingerprint)
      if (state.clientUploadId) item._clientUploadId = state.clientUploadId
      if (state.fingerprint) item._fingerprint = state.fingerprint
      if (state.variants?.original) item._videoResult = state
      item._progress = { ...state, loaded: state.loaded ?? state.received ?? 0 }
      if (state.duration) item._duration = state.duration
      if (newId || identityChanged) persistDraft()
      const now = performance.now()
      if (now - lastPaint < 100) return
      lastPaint = now
      renderPreviews()
      updatePublishGuard()
    }
    persistDraft()
    renderPreviews()
    updatePublishGuard()
    try {
      if (!(await draftReady)) throw new Error('草稿初始化失败，请重新打开编辑器')
      const options = { draftId, needsPoster, signal: controller.signal, onState, uploadId: item._videoJobId || '', clientUploadId: item._clientUploadId || '', fingerprint: item._fingerprint || '' }
      const result = source ? await uploadVideo(source, options) : await waitForVideoUpload(item._videoJobId, options)
      if (disposed || item._removed) return
      applyVideoResult(item, result, needsPoster)
      if (item._parent?._status === 'done' && !item._parent._needsReview) await removeDraftFile(draftId, item._parent._id)
    } catch (error) {
      if (disposed || item._removed) return
      item._status = 'error'
      item._errMsg = error.message || '视频处理失败'
      item._needsFile = Boolean(error.needsFile); item._canRetry = Boolean(error.canRetry)
    } finally {
      videoControllers.delete(item)
      if (!disposed && !item._removed) { renderPreviews(); updatePublishGuard(); persistDraft() }
    }
  }

  // 浏览器封面用于即时预览；不支持原件编码时仍上传，由服务端生成正式封面。
  async function processVideo(file) {
    file._id ||= newDraftId()
    file._kind = 'video'
    file._status = 'processing'
    persistDraft()
    renderPreviews()
    updatePublishGuard()
    try {
      const { duration, poster } = await readVideoPoster(file)
      if (disposed || file._removed) return
      file._duration = duration
      if (poster) { file._posterUrl = URL.createObjectURL(poster); file._url = file._posterUrl }
    } catch { /* 原件无法在浏览器解码时，正式探测与封面交由服务器处理。 */ }
    if (!disposed && !file._removed) await runVideoTask(file, file, true)
  }

  function makeMotion(still, motionFile) {
    return { _id: newDraftId(), name: motionFile.name, _status: 'processing', _parent: still, _file: motionFile }
  }
  async function resumeMotionFromFile(still, selected) {
    try {
      let motion = selected
      if (!isVideoFile(selected)) {
        const [group] = await normalizeMediaFiles([selected])
        if (!group?.motion) throw new Error('此原件没有可提取的完整实况视频')
        motion = group.motion
      }
      if (disposed || still._removed || still._motion?._removed) return
      still._motion._file = motion
      await runVideoTask(still._motion, motion, false)
    } catch (error) { if (!disposed && !still._removed) { errorLine.textContent = error.message; renderPreviews(); updatePublishGuard() } }
  }
  async function keepStillOnly(item) {
    const motion = item._motion
    errorLine.textContent = ''
    item._discarding = true; renderPreviews(); updatePublishGuard()
    try {
      if (motion) {
        motion._removed = true
        videoControllers.get(motion)?.abort()
        if (motion._videoJobId) await cancelVideoUpload(motion._videoJobId)
        else if (motion._name) await api(`/api/uploads/${encodeURIComponent(motion._name)}`, { method: 'DELETE' })
      }
      if (disposed || item._removed) return
      item._motion = null; item._needsReview = false
      item._warnings = [{ code: 'STATIC_ONLY', message: '已选择仅保留静态图', blocking: false }]
      item._source = { ...item._source, pairing: 'static' }
      await removeDraftFile(draftId, item._id)
    } catch (error) {
      errorLine.textContent = `仅保留静态图失败：${error.message}`
      if (motion) { motion._removed = false; motion._status = 'error'; motion._errMsg = error.message }
    } finally { item._discarding = false; if (!disposed && !item._removed) { renderPreviews(); updatePublishGuard(); persistDraft() } }
  }

  // 选完图立刻处理(HEIC 转码 + 压缩)并上传到存储后端,发布时只提交文件名
  async function processFile(file) {
    file._id ||= newDraftId()
    file._kind = 'image'
    await saveDraftFile(draftId, file instanceof Blob ? file : file._originalFile)
    file._status = 'processing'
    persistDraft()
    renderPreviews()
    updatePublishGuard()
    try {
      const normalized = await normalizeHeic(file._uploadStill || file._originalFile || file)
      const compressed = await compressImage(normalized)
      if (disposed || file._removed) return
      if (file._url?.startsWith('blob:')) URL.revokeObjectURL(file._url)
      file._url = URL.createObjectURL(compressed)
      file._status = 'uploading'
      renderPreviews()
      if (!(await draftReady)) throw new Error('草稿初始化失败，请重新打开编辑器')
      if (disposed || file._removed) return
      const form = new FormData()
      form.append('image', compressed)
      form.append('draftId', draftId)
      const { filename } = await api('/api/uploads', { method: 'POST', body: form })
      if (file._removed) { await api(`/api/uploads/${encodeURIComponent(filename)}`, { method: 'DELETE' }); return }
      file._name = filename
      file._status = 'done'; file._errMsg = ''
      if (!disposed && !file._needsReview && (!file._motion || file._motion._status === 'done')) await removeDraftFile(draftId, file._id)
      persistDraft()
    } catch (e) {
      file._status = 'error'
      file._errMsg = e.message || '处理失败'
    }
    if (!disposed && !file._removed) { renderPreviews(); updatePublishGuard(); persistDraft() }
  }

  function uploadProgressText(item) {
    const progress = item._progress
    const labels = { hashing: '校验原文件', connection: '等待网络恢复', receiving: '接收原文件', queued: '原件已接收，等待处理', verifying_source: '验证原文件', saving_original: '保存原文件', probing: '读取视频信息', planning: '建立检查点', audio: '处理音轨', merging: '合并视频', comparing: '对比两份版本', saving_compressed: '保存压缩版本', compressing: '压缩中', remuxing: '优化视频封装', validating: '校验压缩结果', poster: '生成视频封面', registering: '登记视频结果', saving: '保存中', waiting: '处理已暂停' }
    if (progress && labels[progress.phase]) {
      const label = progress.phase === 'saving' && progress.backend === 'webdav' ? '正在保存到 WebDAV' : labels[progress.phase]
      if (['compressing', 'remuxing'].includes(progress.phase)) {
        const estimate = Number.isFinite(progress.estimatedRemainingMs)
          ? `预计剩余约 ${formatVideoElapsed(progress.estimatedRemainingMs)}` : '预计时间计算中…'
        return `${label} ${Math.floor(progress.progress || 0)}% · ${estimate}`
      }
      return label
    }
    if (progress?.total > 0) return `上传中 ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
    return STATUS_TEXT[item._status] || '上传中'
  }

  function renderPreviews() {
    previews.innerHTML = ''
    videoResults.replaceChildren()
    const rows = [
      ...keepImages.map((img) => [keepImages, img]),
      ...newFiles.map((f) => [newFiles, f]),
    ]
    for (const [list, item] of rows) {
      // 已发布的图片/视频/实况图走同一套格子:视频看封面帧,实况图看静帧
      const kind = item._kind || item.type || 'image'
      const live = Boolean(item._motion || item.live)
      const src = item._url || (kind === 'video' ? item.poster : item.url) || ''
      const node = el(`<div class="preview-item${kind === 'video' ? ' is-video' : ''}${src ? '' : ' no-poster'}">${src ? `<img src="${src}" alt="" />` : ''}<button class="remove" aria-label="移除这项媒体">×</button></div>`)
      if (kind === 'video') {
        node.appendChild(el(`<span class="media-play" aria-hidden="true">${icon('play')}</span>`))
        if (item._duration || item.duration) node.appendChild(el(`<span class="media-duration">${formatDuration(item._duration || item.duration)}</span>`))
      } else if (live) {
        node.appendChild(el('<span class="media-live" aria-hidden="true"><span class="lb-live-dot"></span>LIVE</span>'))
        // 配对视频单独上传:失败时在缩略图上直接说清楚,不然用户以为配对成功了
        if (item._motion?._status === 'error') node.appendChild(el(`<div class="upload-overlay error">${esc(item._motion._errMsg || '实况视频上传失败')}</div>`))
      }
      if (item._status && item._status !== 'done') {
        const overlay = el(`<div class="upload-overlay${item._status === 'error' ? ' error' : ''}"></div>`)
        if (item._status === 'error') {
          overlay.textContent = item._errMsg || '失败'
        } else {
          overlay.appendChild(el('<span class="spinner"></span>'))
          overlay.appendChild(el(`<span>${uploadProgressText(item)}</span>`))
        }
        node.appendChild(overlay)
      } else if (item._status === 'done') {
        if (item._motion?._status === 'uploading') {
          const overlay = el('<div class="upload-overlay"></div>')
          overlay.appendChild(el('<span class="spinner"></span>'))
          overlay.appendChild(el(`<span>${uploadProgressText(item._motion)}</span>`))
          node.appendChild(overlay)
        } else {
          node.appendChild(el(`<div class="upload-badge">${icon('check')}</div>`))
        }
      }
      $('.remove', node).onclick = () => {
        item._removed = true
        item._parseController?.abort()
        if (item._motion) item._motion._removed = true
        for (const video of [item, item._motion]) {
          if (!video) continue
          videoControllers.get(video)?.abort()
          if (video._videoJobId) cancelVideoUpload(video._videoJobId).catch((error) => { errorLine.textContent = `取消视频失败：${error.message}` })
        }
        for (const url of [item._url, item._posterUrl]) {
          if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
        }
        // 按对象定位而非渲染时的下标,避免删除过程中列表变动导致删错
        const idx = list.indexOf(item)
        if (idx >= 0) list.splice(idx, 1)
        if (item._jobId) api(`/api/image-jobs/${encodeURIComponent(item._jobId)}`, { method: 'DELETE' }).catch(() => {})
        removeDraftFile(draftId, item._id)
        renderPreviews()
        updatePublishGuard()
        if (item._motion?._name) api(`/api/uploads/${item._motion._name}`, { method: 'DELETE' }).catch(() => {})
        if (item._poster) api(`/api/uploads/${item._poster}`, { method: 'DELETE' }).catch(() => {})
        // 新文件已经传到存储后端了,撤掉时连带删除;已发布的老文件仍由发布时的 keep 决定
        if (item._name) api(`/api/uploads/${item._name}`, { method: 'DELETE' }).catch(() => {})
        persistDraft()
      }
      previews.appendChild(node)
      if (item._warnings?.length || (kind !== 'video' && (item._motion || item._status === 'error'))) {
        const notice = el('<div class="live-photo-notice"></div>')
        const message = el('<p></p>')
        message.textContent = `${item.name || '照片'}：${(item._warnings || []).map((w) => w.message).join('；') || item._errMsg || '实况照片'}`
        notice.appendChild(message)
        if (kind !== 'video' && item._status === 'done' && (item._motion || item._needsReview)) {
          const button = el('<button class="btn btn-ghost" type="button">仅保留静态图</button>')
          button.disabled = Boolean(item._discarding); button.onclick = () => keepStillOnly(item)
          notice.appendChild(button)
        }
        if (kind !== 'video' && item._status === 'error' && !item._parsing) {
          const button = el('<button class="btn btn-ghost" type="button">重试图片</button>')
          button.onclick = () => processFile(item)
          notice.appendChild(button)
        }
        if (kind !== 'video' && (item._status === 'error' || item._needsReview) && !item._parsing) {
          const button = el('<button class="btn btn-ghost" type="button">重新选择原件</button>')
          button.onclick = () => {
            const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.accept = fileInput.accept
            input.onchange = () => { if (input.files.length) { $('.remove', node).click(); handleFiles(input) } }
            input.click()
          }
          notice.appendChild(button)
        }
        videoResults.appendChild(notice)
      }
      for (const video of [item, item._motion]) {
        const result = video?._videoResult
        if (video?._progress && video._status === 'uploading') {
          const line = el('<p></p>')
          line.textContent = `${video.name || '视频'}：${uploadProgressText(video)}。原件上传后会先保存，后台继续处理。`
          videoResults.appendChild(line)
        }
        if (video?._needsFile || video?._canRetry || (video !== item && video?._status === 'error' && video._file)) {
          const line = el('<p></p>'), button = el('<button class="btn btn-ghost" type="button"></button>')
          button.textContent = video._needsFile ? '选择原件续传' : video._canRetry ? '从检查点重试' : '重试实况视频'
          button.onclick = async () => {
            if (!video._needsFile && !video._canRetry && video._file) { runVideoTask(video, video._file, false); return }
            if (video._needsFile) {
              const input = document.createElement('input'); input.type = 'file'
              input.accept = video !== item ? 'image/*,video/*,.heic,.heif,.avif,.mov,.mp4' : 'video/*,.mov,.mp4,.webm'
              input.onchange = () => { if (input.files[0]) video !== item ? resumeMotionFromFile(item, input.files[0]) : runVideoTask(video, input.files[0], true) }
              input.click()
            } else {
              button.disabled = true
              try { await retryVideoUpload(video._videoJobId); runVideoTask(video, null, video === item && kind === 'video') }
              catch (error) { errorLine.textContent = error.message; button.disabled = false }
            }
          }
          line.append(button); videoResults.appendChild(line)
        }
        if (!result || !['done', 'error', 'selecting'].includes(video._status)) continue
        const line = el('<div class="video-comparison"></div>')
        const summary = el('<p></p>')
        summary.textContent = `${video.name || '视频'}：${result.message || ''}${Number.isFinite(result.totalElapsedMs) ? ` · 总计 ${formatVideoElapsed(result.totalElapsedMs)}` : ''}`
        line.append(summary)
        for (const [variant, label] of [['original', '原文件'], ['compressed', '压缩版本']]) {
          const version = result.variants?.[variant]
          if (!version) continue
          const row = el('<p></p>')
          row.textContent = `${label}：${formatVideoBytes(version.size)} · ${version.codec || '待探测'} · ${version.width || '?'}×${version.height || '?'} · ${Number(version.rate || 0).toFixed(2)}fps · ${version.bitDepth || '?'}bit · ${version.hdr ? 'HDR' : 'SDR'}${result.recommendedVariant === variant ? ' · 推荐' : ''}`
          if (result.canSelect && version.available !== false && version.codec) {
            const choose = el('<button class="btn btn-ghost" type="button"></button>')
            choose.textContent = result.selectedVariant === variant && video._status === 'done' ? '已采用' : `采用${label}`
            choose.disabled = video._status === 'selecting' || (result.selectedVariant === variant && video._status === 'done')
            choose.onclick = async () => {
              video._status = 'selecting'; renderPreviews(); updatePublishGuard()
              try { const chosen = await selectVideoVariant(video._videoJobId, variant); if (disposed || video._removed) return; applyVideoResult(video, chosen, video === item && kind === 'video') }
              catch (error) { if (!disposed && !video._removed) { video._status = result.status === 'failed' ? 'error' : 'done'; errorLine.textContent = error.message } }
              finally { if (!disposed && !video._removed) { renderPreviews(); updatePublishGuard(); persistDraft() } }
            }
            row.append(' ', choose)
          }
          line.append(row)
        }
        if (result.comparison?.compressed) {
          const details = el('<p></p>'), saved = result.comparison.savingPercent
          details.textContent = `${saved >= 0 ? '节省' : '增大'} ${Math.abs(saved).toFixed(1)}% · 压缩后/原件 ${(result.comparison.compressionRatio * 100).toFixed(1)}%。${result.comparison.changes.join('；')}`
          line.append(details)
        }
        videoResults.appendChild(line)
      }
    }
    videoResults.hidden = videoResults.childElementCount === 0
  }

  // 发布守卫:任一媒体(含实况配对视频)还在处理或上传中则禁用发布
  const MEDIA_PENDING = ['processing', 'uploading', 'selecting']
  const videoUnresolved = () => newFiles.some((file) => file._status === 'error' || file._needsReview || file._discarding || file._motion?._status === 'error')
  function updatePublishGuard() {
    const pending = restoringMedia || newFiles.some((f) => MEDIA_PENDING.includes(f._status) || MEDIA_PENDING.includes(f._motion?._status))
    const generating = imageTask && ['queued', 'running', 'uploading'].includes(imageTask.status)
    submitBtn.disabled = Boolean(mediaRestoreError) || pending || generating || videoUnresolved()
    if (mediaRestoreError) submitBtn.textContent = '恢复失败，请重新打开编辑器'
    else if (videoUnresolved()) submitBtn.textContent = '请处理失败或待确认的媒体'
    else if (pending) submitBtn.textContent = '媒体处理中…'
    else if (generating) submitBtn.textContent = 'AI 配图生成中…'
    else submitBtn.textContent = post ? '保存' : '发布'
  }
  renderPreviews()
  updatePublishGuard()

  $('.pick', card).onclick = () => fileInput.click()
  $('.camera', card).onclick = () => cameraInput.click()
  const handleFiles = async (input) => {
    const picked = [...input.files]
    input.value = ''
    if (!picked.length) return
    const controller = new AbortController()
    parseControllers.add(controller)
    const placeholder = { _id: newDraftId(), name: `解析 ${picked.length} 个文件`, _parsing: true, _status: 'processing', _kind: 'image', _parseController: controller }
    newFiles.push(placeholder); renderPreviews(); updatePublishGuard()
    try {
      await restoreReady
      controller.signal.throwIfAborted()
      for (const original of picked) {
        if (isVideoFile(original)) continue
        original._id ||= newDraftId()
        await saveDraftFile(draftId, original)
      }
      const groups = await normalizeMediaFiles(picked, { signal: controller.signal })
      if (disposed || placeholder._removed) return
      const index = newFiles.indexOf(placeholder)
      if (index >= 0) newFiles.splice(index, 1)
      const work = []
      for (const group of groups) {
        const item = group.original || group.video || group.still
        item._id ||= newDraftId(); item._source = group.source; item._warnings = group.warnings
        item._needsReview = group.kind !== 'video' && group.warnings.some((w) => w.blocking)
        item._status = 'processing'; item._kind = group.video ? 'video' : 'image'
        item._uploadStill = group.still
        if (group.motion) item._motion = makeMotion(item, group.motion)
        newFiles.push(item)
        work.push(() => group.video ? processVideo(item) : processFile(item))
        if (group.motion) work.push(() => runVideoTask(item._motion, group.motion, false))
      }
      renderPreviews(); updatePublishGuard(); persistDraft()
      for (const task of work) task()
    } catch (error) {
      if (!controller.signal.aborted && !disposed) { placeholder._status = 'error'; placeholder._errMsg = error.message; errorLine.textContent = error.message }
    } finally {
      parseControllers.delete(controller)
      if (placeholder._removed) for (const original of picked) if (original._id) await removeDraftFile(draftId, original._id)
      if (!disposed) { renderPreviews(); updatePublishGuard(); persistDraft() }
    }
  }
  fileInput.onchange = () => handleFiles(fileInput)
  cameraInput.onchange = () => handleFiles(cameraInput)

  submitBtn.onclick = async () => {
    const content = textarea.value.trim()
    const ready = newFiles.filter((f) => f._status === 'done' && !MEDIA_PENDING.includes(f._motion?._status) && f._motion?._status !== 'error')
    if (!content && keepImages.length + ready.length === 0) {
      errorLine.textContent = '写点什么或传张图吧'
      return
    }
    if (restoringMedia || mediaRestoreError || videoUnresolved() || newFiles.some((f) => MEDIA_PENDING.includes(f._status) || MEDIA_PENDING.includes(f._motion?._status))) return
    submitBtn.disabled = true
    submitBtn.textContent = '发布中…'
    errorLine.textContent = ''
    try {
      await draftReady
      const payload = {
        content,
        draftId,
        images: ready.map((f) => {
          const media = { filename: f._name }
          if (f._motion?._name) media.motion = f._motion._name
          if (f._poster) media.poster = f._poster
          if (f._duration) media.duration = f._duration
          return media
        }),
      }
      if (post) payload.keep = keepImages.map((img) => img.id)
      const pubText = $('[name=publicText]', card)
      const pubImages = $('[name=publicImages]', card)
      if (pubText) payload.publicText = pubText.checked
      if (pubImages) payload.publicImages = pubImages.checked
      const result = await api(post ? `/api/posts/${post.id}` : '/api/posts', {
        method: post ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      onDone(result)
    } catch (e) {
      errorLine.textContent = e.message
      submitBtn.disabled = false
      updatePublishGuard()
    }
  }
  if (post) $('.cancel', card).onclick = onCancel
  if (!post) $('.discard-draft', card).onclick = async () => {
    if (!confirm('确定丢弃这篇未发布的草稿吗？')) return
    onCancel()
    await api(`/api/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => {})
    clearComposeState(draftId)
    await clearDraftFiles(draftId)
  }
  return card
}

// ---------- 归档时间导航 ----------

// 服务端按本地时区分月,这里的口径必须与之一致,否则高亮会和跳转错位
const tzOffset = () => -new Date().getTimezoneOffset()
const monthKey = (createdAt) => {
  const d = parseTime(createdAt)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const monthTitle = (month) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`

// 两种形态,同一份数据同一个 onPick,由媒体查询各显其一:
//   宽屏 → 阅读列左侧的纯文字大纲(像文档大纲,跟随滚动高亮当前月份)
//   窄屏 → 右边缘的刻度索引(通讯录 A-Z / 照片 App 日期滑块的做法,可点可拖)
// 两者都是 fixed,不占阅读列、不打断正文流 —— 内联面板横在发布框与时间轴之间太重。
// display: none 会同时把另一份从无障碍树摘掉,不必再补 aria-hidden。
function renderArchive(months, onPick) {
  const wrap = el('<div class="archive"></div>')
  const outline = el('<nav class="archive-outline" aria-label="按月份浏览"><button class="archive-latest" type="button">最新</button></nav>')
  const rail = el('<nav class="archive-rail" aria-label="按月份浏览"><div class="archive-ticks"></div><span class="archive-bubble" hidden></span></nav>')
  const ticksBox = $('.archive-ticks', rail)
  const bubble = $('.archive-bubble', rail)
  const rows = new Map() // month → 大纲行
  const ticks = new Map() // month → 刻度
  const counts = new Map(months.map((m) => [m.month, m.count]))

  let year = null
  for (const { month, count } of months) {
    const y = month.slice(0, 4)
    const newYear = y !== year
    if (newYear) {
      year = y
      outline.appendChild(el(`<div class="archive-year">${y}</div>`))
    }
    const row = el(`<button class="archive-row" type="button"><span>${Number(month.slice(5))}月</span><small>${count}</small></button>`)
    row.title = `跳转到 ${monthTitle(month)}(${count} 条)`
    row.onclick = () => onPick(month)
    outline.appendChild(row)
    rows.set(month, row)

    // 年份交界处以年份数字代替刻度线,和照片 App 一样用最少的字交代位置
    const tick = el(`<button class="archive-tick" type="button" aria-label="${monthTitle(month)},${count} 条">${newYear ? `<em>${y.slice(2)}</em>` : '<i></i>'}</button>`)
    tick.dataset.month = month
    tick.onclick = () => onPick(month)
    ticksBox.appendChild(tick)
    ticks.set(month, tick)
  }
  $('.archive-latest', outline).onclick = () => onPick(null)

  // 拖动刻度条时只用气泡预览月份,松手才真正跳转:边拖边加载会连打十几个请求
  const tickAt = (clientY) => {
    const box = ticksBox.getBoundingClientRect()
    return document.elementFromPoint(box.left + box.width / 2, clientY)?.closest('.archive-tick')
  }
  const preview = (tick) => {
    const month = tick.dataset.month
    bubble.textContent = `${monthTitle(month)} · ${counts.get(month)} 条`
    bubble.style.top = `${tick.getBoundingClientRect().top + tick.getBoundingClientRect().height / 2 - rail.getBoundingClientRect().top}px`
    animatePresence(bubble, true, { className: 'bubble-presence', duration: 160 })
    for (const t of ticks.values()) t.classList.toggle('hot', t === tick)
  }
  const endDrag = (commit) => {
    animatePresence(bubble, false, { className: 'bubble-presence', duration: 160 })
    for (const t of ticks.values()) t.classList.remove('hot')
    // 只有真的拖到了别的月份才在这里提交;原地点按交给刻度自身的 click,免得跳两次
    if (commit && dragTo && dragTo !== dragFrom) onPick(dragTo.dataset.month)
    dragFrom = dragTo = null
  }
  let dragFrom = null
  let dragTo = null
  ticksBox.addEventListener('pointerdown', (e) => {
    const tick = tickAt(e.clientY)
    if (!tick) return
    // 指针已抬起或来自合成事件时 setPointerCapture 会抛错。抓不到只是手指横向移出刻度条后
    // 跟手性变差,不该让整个 pointerdown 处理中断
    try { ticksBox.setPointerCapture(e.pointerId) } catch {}
    dragFrom = dragTo = tick
    preview(tick)
  })
  ticksBox.addEventListener('pointermove', (e) => {
    if (!dragFrom) return
    const tick = tickAt(e.clientY)
    if (tick && tick !== dragTo) preview((dragTo = tick))
  })
  ticksBox.addEventListener('pointerup', () => endDrag(true))
  ticksBox.addEventListener('pointercancel', () => endDrag(false))

  // 当前所在月份由时间轴按滚动位置回灌,这是「大纲」区别于「菜单」的地方
  wrap.setHere = (month) => {
    for (const [key, row] of rows) row.classList.toggle('here', key === month)
    for (const [key, tick] of ticks) tick.classList.toggle('here', key === month)
    // 月份多到大纲要滚动时,把当前项带进视野。只动大纲自己的 scrollTop,
    // 不用 scrollIntoView —— 它会连带滚动窗口,和用户的滚动打架
    const row = rows.get(month)
    if (!row || outline.scrollHeight <= outline.clientHeight) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top < outline.scrollTop) outline.scrollTop = top - 24
    else if (bottom > outline.scrollTop + outline.clientHeight) outline.scrollTop = bottom - outline.clientHeight + 24
  }
  wrap.append(outline, rail)
  return wrap
}

// ---------- 时间轴视图 ----------

// 通知跳转后待高亮的评论:{ postId, commentId },评论列表加载完成时消费
let pendingCommentFocus = null

// 评论区块:使用朋友圈式的扁平回复关联,不渲染嵌套楼层。
function renderComments(p) {
  const wrap = el(`<div class="comments" hidden><div class="comments-list"></div><div class="comment-form" hidden></div></div>`)
  const listEl = $('.comments-list', wrap)
  let form = null
  let input = null
  let replyTarget = null
  let replyState = null

  function flashComment(id) {
    const target = listEl.querySelector(`[data-cid="${id}"]`)
    if (!target) return
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' })
    target.classList.remove('flash')
    void target.offsetWidth // 强制回流,同一目标可重复触发动画
    target.classList.add('flash')
  }

  function setReplyTarget(comment = null) {
    replyTarget = comment ? { id: comment.id, author: comment.author } : null
    if (!replyState || !input) return
    replyState.hidden = !replyTarget
    $('.comment-reply-target', replyState).textContent = replyTarget ? `回复 ${replyTarget.author}` : ''
    input.placeholder = replyTarget ? '写下回复…' : '写条评论…'
  }

  function openComposer(comment = null) {
    if (!form || !input) return
    activeInlineComposerCleanup?.()
    activeInlineComposerCleanup = attachInlineInputViewport(form, input)
    setReplyTarget(comment)
    animatePresence(wrap, true, { className: 'panel-presence', duration: 200 })
    animatePresence(form, true, { className: 'panel-presence', duration: 180 })
    input.focus()
  }

  async function load() {
    listEl.innerHTML = ''
    try {
      const { comments } = await api(`/api/posts/${p.id}/comments`)
      if (comments.length === 0) {
        if (!form || form.hidden) animatePresence(wrap, false, { className: 'panel-presence', duration: 200 })
        return
      }
      animatePresence(wrap, true, { className: 'panel-presence', duration: 200 })
      for (const c of comments) {
        const item = el(`
          <div class="comment">
            <span class="comment-avatar"></span>
            <div class="comment-body">
              <div class="comment-meta"><b>${esc(c.author)}</b> <span class="comment-time">${formatTime(c.created_at)}</span></div>
              <div class="comment-text"></div>
            </div>
            <div class="comment-actions"></div>
          </div>`)
        $('.comment-avatar', item).replaceWith(avatarNode(c.author, c.avatarUrl, 'tiny'))
        item.dataset.cid = c.id
        if (c.reply_author) {
          const meta = $('.comment-meta', item)
          const time = $('.comment-time', item)
          meta.insertBefore(el('<span class="comment-reply-label">回复</span>'), time)
          meta.insertBefore(el(`<b class="comment-reply-author">${esc(c.reply_author)}</b>`), time)
          // 引用被回复的原文,点击跳转定位,解决"看不出回复的是哪一条"
          if (c.reply_content) {
            const excerpt = c.reply_content.length > 40 ? c.reply_content.slice(0, 40) + '…' : c.reply_content
            const quote = el('<button class="comment-quote" type="button" title="查看原评论"></button>')
            quote.textContent = `${c.reply_author}:${excerpt}`
            quote.onclick = () => flashComment(c.reply_to)
            $('.comment-body', item).insertBefore(quote, $('.comment-text', item))
          }
        }
        $('.comment-text', item).textContent = c.content
        const actions = $('.comment-actions', item)
        if (site.user) {
          const replyBtn = el('<button class="link-btn" type="button" title="回复评论">回复</button>')
          replyBtn.onclick = () => openComposer(c)
          actions.appendChild(replyBtn)
        }
        if (site.user && (c.user_id === site.user.id || p.user_id === site.user.id) && withinEditWindow(c.created_at)) {
          const btn = el('<button class="link-btn" title="删除评论">删除</button>')
          btn.onclick = async () => {
            if (!confirm('删除这条评论?')) return
            try {
              await api(`/api/posts/${p.id}/comments/${c.id}`, { method: 'DELETE' })
              if (replyTarget?.id === c.id) setReplyTarget()
              await load()
            } catch (e) {
              alert(e.message)
            }
          }
          actions.appendChild(btn)
        }
        listEl.appendChild(item)
      }
      // 通知跳转:评论加载完成后定位并高亮目标评论
      if (pendingCommentFocus?.postId === p.id) {
        const { commentId } = pendingCommentFocus
        pendingCommentFocus = null
        flashComment(commentId)
      }
    } catch { /* 私密模式未登录等,静默 */ }
  }

  if (site.user) {
    form = $('.comment-form', wrap)
    replyState = el('<div class="comment-reply-state" hidden><span class="comment-reply-target"></span><button class="comment-reply-cancel" type="button" title="取消回复" aria-label="取消回复">&times;</button></div>')
    input = el(`<input class="comment-input" type="text" name="comment-${p.id}" aria-label="评论内容" placeholder="写条评论…" maxlength="500" />`)
    const emojiBtn = el(`<button class="emoji-toggle" type="button" title="表情" aria-label="插入表情">${icon('smile')}</button>`)
    attachEmojiButton(emojiBtn, input)
    const btn = el('<button class="btn tiny">评论</button>')
    $('.comment-reply-cancel', replyState).onclick = () => setReplyTarget()
    wrap.openComposer = () => openComposer()
    const post_comment = async () => {
      const content = input.value.trim()
      if (!content) return
      btn.disabled = true
      try {
        const payload = { content }
        if (replyTarget) payload.replyToId = replyTarget.id
        await api(`/api/posts/${p.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        input.value = ''
        setReplyTarget()
        await load()
      } catch (e) {
        alert(e.message)
      } finally {
        btn.disabled = false
      }
    }
    btn.onclick = post_comment
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post_comment() } }
    form.append(replyState, input, emojiBtn, btn)
  }
  load()
  return wrap
}

function renderReactions(p) {
  const wrap = el('<div class="post-reactions"></div>')
  const render = (reactions = p.reactions || []) => {
    wrap.innerHTML = ''
    for (const reaction of reactions) {
      const btn = el(`<button class="reaction ${reaction.reacted ? 'active' : ''}" type="button"><span>${reaction.emoji}</span><small>${reaction.count}</small></button>`)
      btn.title = `${reaction.reacted ? '取消' : '添加'}${reaction.emoji}`
      btn.onclick = () => toggleReaction(reaction.emoji)
      wrap.appendChild(btn)
    }
  }
  async function toggleReaction(emoji) {
    if (!site.user) { location.hash = '#/login'; return }
    try {
      const data = await api(`/api/posts/${p.id}/reactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }) })
      p.reactions = data.reactions
      render(data.reactions)
    } catch (e) { alert(e.message) }
  }
  wrap.addReaction = toggleReaction
  render()
  return wrap
}

function renderPostMenu(p, comments, reactions) {
  const menu = el(`<div class="post-menu" role="menu" hidden><button class="post-menu-comment" role="menuitem" type="button">${icon('message-circle')}<span>评论</span></button><div class="reaction-picker"></div></div>`)
  const picker = $('.reaction-picker', menu)
  for (const emoji of reactionEmojis()) {
    const button = el(`<button type="button" role="menuitem" class="reaction-option">${emoji}</button>`)
    button.title = `点评 ${emoji}`
    button.onclick = () => { reactions.addReaction(emoji); closePostMenu() }
    picker.appendChild(button)
  }
  $('.post-menu-comment', menu).onclick = () => {
    if (!site.user) { location.hash = '#/login'; return }
    comments.openComposer?.()
    closePostMenu()
  }
  return menu
}

// 列表里的媒体格子:图片给静帧;视频给封面帧 + 播放角标 + 时长;实况图给静帧 + LIVE 角标。
// 一律不自动播放、不预加载视频 —— 只有封面图会被真的加载,格子再多也不会拖着视频文件走。
// 视频在这个格子里原地播放,所以格子是容器:封面撑尺寸,点击层、播放器层、收起按钮各占一层。
// 播放器由 inline-video.js 在点击时建到 .media-player 里(ArtPlayer 会自己重建里面的 DOM)。
function mediaTile(media) {
  const isVideo = media.type === 'video'
  const poster = isVideo ? (media.poster || '') : media.url
  // 封面一律是装饰图:格子的可读名字由点击层的 aria-label 给,免得读两遍
  const tile = el(`<div class="media-tile${isVideo ? ' is-video' : ''}${poster ? '' : ' no-poster'}">${poster ? `<img src="${esc(poster)}" alt="" loading="lazy" />` : ''}</div>`)
  if (isVideo) {
    tile.append(el(`<span class="media-play" aria-hidden="true">${icon('play')}</span>`))
    if (media.duration) tile.append(el(`<span class="media-duration">${formatDuration(media.duration)}</span>`))
  } else if (media.live) {
    tile.append(el('<span class="media-live" aria-hidden="true"><span class="lb-live-dot"></span>LIVE</span>'))
  }
  tile.append(el(`<button class="media-hit" type="button" aria-label="${isVideo ? '播放视频' : '查看照片'}"></button>`))
  if (isVideo) {
    tile.append(
      el('<div class="media-player" hidden></div>'),
      el(`<button class="media-collapse" type="button" aria-label="收起视频" hidden>${icon('x')}</button>`),
    )
  }
  return tile
}

// 时间轴与相册共用:图片与实况图交给灯箱,视频在自己格子里播 —— 两种交互不互相穿插
function mediaTileAction(tile, media, photos) {
  const hit = $('.media-hit', tile)
  if (media.type === 'video') {
    hit.onclick = () => playInlineVideo(tile, media, { onError: () => showToast('浏览器或设备无法解码此视频，请尝试支持 HEVC 的浏览器或设备') })
    // 收起按钮是点击层的兄弟节点(不能套在按钮里),事件不会冒泡过去,得单独接
    $('.media-collapse', tile).onclick = () => stopInlineVideo()
    return hit
  }
  hit.onclick = () => { stopInlineVideo(); openLightbox(photos, photos.indexOf(media), hit) }
  return hit
}

function renderMediaGrid(grid, list) {
  const photos = list.filter((media) => media.type !== 'video')
  // 播放器脚本先取回来:iOS 只有在点击手势里同步开始播放才放声音
  if (list.some((media) => media.type === 'video')) void preloadInlineVideoPlayer()
  for (const media of list) {
    const tile = mediaTile(media)
    mediaTileAction(tile, media, photos)
    grid.appendChild(tile)
  }
}

function renderPost(p) {
  // 私密模式下未登录访客:按文章开关决定可见性,默认全隐
  const guest = site.privateMode && !site.user
  const showText = !guest || Boolean(p.public_text)
  const showImages = !guest || Boolean(p.public_images)

  const card = el(`
    <article class="card post">
      <div class="post-head">
        <span class="post-avatar"></span>
        <div class="post-meta">
          <div class="post-author">${esc(p.author)}</div>
          <div class="post-time">${formatTime(p.created_at)}${p.updated_at !== p.created_at ? ' · 已编辑' : ''}</div>
        </div>
        <div class="post-actions"><button class="more-btn" type="button" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${icon('ellipsis')}</button></div>
      </div>
      <div class="post-content"></div>
      <div class="img-grid n${p.images.length}" ${p.images.length ? '' : 'hidden'}></div>
    </article>`)

  $('.post-avatar', card).replaceWith(avatarNode(p.author, p.avatarUrl))

  if (p.content && showText) {
    const contentEl = $('.post-content', card)
    // marked 不做 HTML 消毒,正文是用户输入(还可能经过 AI 改写),必须过 DOMPurify 再进 DOM
    contentEl.innerHTML = DOMPurify.sanitize(marked.parse(p.content))
    // 未登录访客:正文内嵌图片在「公开图片」未开时仍隐藏
    if (guest && !showImages) {
      contentEl.querySelectorAll('img').forEach((img) => {
        const span = document.createElement('span')
        span.className = 'img-hidden-note'
        span.textContent = '[图片仅登录可见]'
        img.replaceWith(span)
      })
    }
  } else if (guest && !showText) {
    const contentEl = $('.post-content', card)
    contentEl.innerHTML = ''
    contentEl.appendChild(el(`<div class="img-hidden-note">${icon('lock')}<span>仅两位成员可见</span></div>`))
  } else $('.post-content', card).remove()

  const grid = $('.img-grid', card)
  renderMediaGrid(grid, p.images)

  const comments = renderComments(p)
  const reactions = renderReactions(p)
  card.append(reactions, comments)
  const menu = renderPostMenu(p, comments, reactions)
  const moreBtn = $('.more-btn', card)
  moreBtn.onclick = (e) => {
    e.stopPropagation()
    const isOpen = activePostMenu?.menu === menu && menu.classList.contains('menu-presence-present') && !menu.classList.contains('menu-presence-closing')
    if (isOpen) {
      closePostMenu()
      return
    }
    closePostMenu()
    activePostMenu = { menu, button: moreBtn }
    moreBtn.setAttribute('aria-expanded', 'true')
    animatePresence(menu, true, { className: 'menu-presence', duration: 180 })
  }
  $('.post-actions', card).append(menu)
  menu.onclick = (e) => e.stopPropagation()

  // 编辑/删除入口由服务端下发的 canEdit 决定(以服务端时间为准,不受客户端时钟影响)
  if (p.canEdit) {
    const actions = $('.post-actions', card)
    const editBtn = el('<button>编辑</button>')
    const delBtn = el('<button>删除</button>')
    editBtn.onclick = (event) => openComposerModal(p, event.currentTarget)
    delBtn.onclick = async () => {
      if (!confirm('确定删除这条动态吗?')) return
      await api(`/api/posts/${p.id}`, { method: 'DELETE' }).catch((e) => alert(e.message))
      renderTimeline()
    }
    actions.append(editBtn, delBtn)
  }

  // 评论属于文字内容，私密模式下仅随公开正文向访客展示。
  if (!showText) comments.remove()
  return card
}

async function renderTimeline(month = null) {
  clearMain()
  main.classList.add('timeline-page')
  const heading = el(`<div class="journal-heading"><div><h1>日常手记</h1><p class="journal-subtitle">把普通的一天，留给以后再看。<span class="journal-count"></span></p></div><div class="journal-heading-actions">${site.user ? `<button class="write-trigger" type="button">${icon('pen-line')}<span>写日常</span></button>` : ''}</div></div>`)
  main.appendChild(heading)
  const writeInHeading = $('.write-trigger', heading)
  writeInHeading?.addEventListener('click', (event) => openComposerModal(null, event.currentTarget))
  if (writeInHeading) watchHeaderWrite(writeInHeading)

  // 归档导航只在跨月时才有意义,单月站点不渲染
  const { months, total } = await api(`/api/posts/archive?tz=${tzOffset()}`).catch(() => ({ months: [] }))
  $('.journal-count', heading).textContent = Number.isFinite(total) ? `${total} 篇日常` : ''
  const archive = months.length > 1 ? renderArchive(months, (pick) => renderTimeline(pick)) : null
  if (archive) main.appendChild(archive)

  const list = el('<div class="post-list"></div>')
  const footer = el('<div class="load-footer"></div>')
  // 顶部哨兵:滚过它就说明已经离开首屏,此时才需要回到顶部按钮
  const topSentinel = el('<div class="top-sentinel" aria-hidden="true"></div>')
  main.append(topSentinel, list, footer)
  // 锚点落在某月时就从该月月末往前取,之后一律用服务端下发的游标续页
  let query = month ? `month=${month}&tz=${tzOffset()}` : ''
  let hasMore = true
  let loading = false
  let lastDate = ''
  let group = null // 当前日期分组;跨页仍指向同一组,同一天的动态不会被分页切成两组
  let empty = true

  // 大纲跟随滚动高亮当前月份:只认可见分组里 DOM 顺序最靠前的那个(即屏幕最上方的),
  // 用序号比较而非读 getBoundingClientRect,避免每次相交回调都触发布局
  const visibleGroups = new Set()
  const groupOrder = new Map()
  const groupObserver = archive && new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleGroups.add(entry.target)
      else visibleGroups.delete(entry.target)
    }
    let top = null
    for (const g of visibleGroups) if (!top || groupOrder.get(g) < groupOrder.get(top)) top = g
    if (top) archive.setHere(top.dataset.month)
  })
  if (groupObserver) timelineObservers.push(groupObserver)

  async function loadPage() {
    if (loading || !hasMore) return
    loading = true
    footer.innerHTML = ''
    footer.appendChild(el('<div class="load-more-tip">加载中…</div>'))
    try {
      const data = await api(`/api/posts?limit=${PAGE_SIZE}&${query}`)
      for (const p of data.posts) {
        const label = dateLabel(p.created_at)
        if (label !== lastDate) {
          lastDate = label
          // 每天独立成组:日期分隔条吸顶时只在本组范围内停留,滚过即被顶出,
          // 扁平结构会让所有分隔条堆在同一位置、叠出一摞 backdrop-filter 合成层
          group = el('<section class="day-group"></section>')
          group.dataset.month = monthKey(p.created_at)
          // 分隔条不带 reveal:translateY 会和 sticky 叠加导致吸顶位置抖动
          group.appendChild(el(`<div class="date-divider">${label}</div>`))
          list.appendChild(group)
          groupOrder.set(group, groupOrder.size)
          groupObserver?.observe(group)
        }
        group.appendChild(reveal(renderPost(p)))
      }
      empty = empty && data.posts.length === 0
      hasMore = data.hasMore
      query = data.nextCursor ? `cursor=${encodeURIComponent(data.nextCursor)}` : ''
      footer.innerHTML = ''
      if (empty) {
        footer.appendChild(emptyJournal(month ? '这段时光，还是空白' : '故事，从今天开始', '那些微小却珍贵的瞬间，都值得被记住。'))
      }
    } catch (e) {
      // 自动加载失败时回落成手动重试,不把用户卡在转圈里
      footer.innerHTML = ''
      const retry = el(`<button class="btn-ghost load-more">重新加载</button>`)
      retry.onclick = loadPage
      footer.append(el(`<div class="form-error">${esc(e.message)}</div>`), retry)
    } finally {
      loading = false
    }
  }

  await loadPage()
  // 哨兵进入视口(提前 400px)即自动续页;并发由 loading 守卫,终止由 hasMore 决定,
  // 因此首屏不满一屏时会自动连续补页直到填满或到底
  const sentinel = el('<div class="load-sentinel" aria-hidden="true"></div>')
  main.appendChild(sentinel)
  observeViewport(sentinel, (visible) => { if (visible) loadPage() }, { rootMargin: '0px 0px 400px 0px' })

  // 列表顶部离开视口就露出「回到顶部」,省掉 scroll 监听与节流
  const toTop = el(`<button class="to-top" type="button" title="回到顶部" aria-label="回到顶部" hidden>${icon('arrow-up')}</button>`)
  // 不显式传 behavior,继承 CSS 的 scroll-behavior,从而自动跟随 reduced-motion 降级
  toTop.onclick = () => window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  main.appendChild(toTop)
  observeViewport(topSentinel, (visible) => (toTop.hidden = visible))

  if (month) window.scrollTo({ top: 0 })
}

// ---------- 单条动态视图(通知跳转的落地页) ----------

async function renderSinglePost(id) {
  clearMain()
  installToTop()
  main.appendChild(el(`<a class="btn-ghost single-back" href="#/">${icon('arrow-left')}<span>返回时间轴</span></a>`))
  try {
    const { post } = await api(`/api/posts/${id}`)
    main.appendChild(renderPost(post))
  } catch (e) {
    main.appendChild(el(`<div class="empty-tip">${esc(e.message)}</div>`))
  }
}

// ---------- 相册视图 ----------

async function renderGallery() {
  clearMain()
  main.classList.add('gallery-page')
  installToTop()
  const heading = el('<div class="page-heading"><div><p>我们的日常</p><h1>影像集</h1></div><span class="gallery-count"></span></div>')
  $('p', heading).textContent = site.title
  main.appendChild(heading)
  try {
    const { images } = await api('/api/gallery')
    const hasVideo = images.some((img) => img.type === 'video')
    $('.gallery-count', heading).textContent = images.length === 0 ? ''
      : `${images.length} ${hasVideo ? '项影像' : '张照片'}`
    if (images.length === 0) {
      main.appendChild(emptyJournal('等待第一张，一起的照片', '留住眼前的风景，也留住那一刻的心情。', '/images/journal-cover.jpg'))
      return
    }
    // 灯箱只承载图片与实况图;视频有自己的原地播放器,不进灯箱序列
    const photos = images.filter((media) => media.type !== 'video')
    if (images.some((media) => media.type === 'video')) void preloadInlineVideoPlayer()
    // 按年月分段:跨度一大,连续网格就变成了没有时间坐标的缩略图墙
    const months = new Map()
    for (const media of images) {
      const at = parseTime(media.created_at)
      const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
      if (!months.has(key)) months.set(key, [])
      months.get(key).push(media)
    }
    for (const [key, list] of months) {
      const [year, month] = key.split('-')
      const section = el(`<section class="gallery-month">
        <h2 class="gallery-month-heading"><span>${year}年${Number(month)}月</span><span class="gallery-month-count">${list.length}</span></h2>
        <div class="gallery-grid"></div>
      </section>`)
      const grid = $('.gallery-grid', section)
      // 灯箱序列跨月连续:在相册里可以直接一路翻到上个月
      list.forEach((media) => {
        const caption = `${media.author} · ${formatTime(media.created_at)}`
        const tile = mediaTile(media)
        tile.classList.add('gallery-photo')
        tile.append(el(`<span class="media-caption">${esc(caption)}</span>`))
        const hit = mediaTileAction(tile, media, photos)
        hit.setAttribute('aria-label', `${media.type === 'video' ? '播放视频' : '查看照片'}：${caption}`)
        grid.appendChild(tile)
      })
      main.appendChild(section)
    }
  } catch (e) {
    main.appendChild(el(`<div class="empty-tip">${esc(e.message)}</div>`))
  }
}

// ---------- 登录视图 ----------

function renderLogin() {
  clearMain()
  main.classList.add('login-page')
  const form = el(`
    <form class="login-card">
      <div class="journal-cover login-cover"><img src="/images/journal-cover.jpg" alt="" /></div>
      <span class="empty-symbol" aria-hidden="true">${icon('heart')}</span><h1>欢迎回家</h1>
      <div class="sub">今天的故事，想从哪里说起？</div>
      <label for="login-username">登录账号</label>
      <input id="login-username" name="username" placeholder="输入你的账号" autocomplete="username" autocapitalize="none" spellcheck="false" required />
      <label for="login-password">密码</label>
      <input id="login-password" name="password" type="password" placeholder="输入密码" autocomplete="current-password" required />
      <div class="form-error" role="alert"></div>
      <button class="btn" type="submit">登录</button>
    </form>`)
  form.onsubmit = async (event) => {
    event.preventDefault()
    const submit = $('.btn', form)
    const error = $('.form-error', form)
    error.textContent = ''
    submit.disabled = true
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('[name=username]', form).value.trim(), password: $('[name=password]', form).value }),
      })
      location.hash = '#/'
      location.reload()
    } catch (e) {
      error.textContent = e.message
    } finally {
      submit.disabled = false
    }
  }
  main.appendChild(form)
}

async function openAvatarCropper(file, onConfirm, onCancel) {
  const overlay = el(`<div class="avatar-crop-overlay" role="dialog" aria-modal="true" aria-label="裁剪头像">
    <div class="avatar-crop-dialog">
      <div class="avatar-crop-heading"><h2>调整头像</h2><button class="avatar-crop-close" type="button" aria-label="取消">×</button></div>
      <p class="avatar-crop-hint">拖动图片调整位置，使用滑块缩放</p>
      <div class="avatar-crop-stage"><canvas width="256" height="256"></canvas></div>
      <label class="avatar-zoom">缩放<input type="range" min="1" max="3" step="0.01" value="1" /></label>
      <div class="avatar-crop-actions"><button class="btn-ghost avatar-crop-cancel" type="button">取消</button><button class="btn avatar-crop-confirm" type="button">使用此头像</button></div>
    </div>
  </div>`)
  const canvas = $('canvas', overlay)
  const ctx = canvas.getContext('2d')
  const stage = $('.avatar-crop-stage', overlay)
  const zoomInput = $('input[type=range]', overlay)
  const confirmButton = $('.avatar-crop-confirm', overlay)
  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  let baseScale = 1
  let zoom = 1
  let offsetX = 0
  let offsetY = 0
  let drag = null
  let closed = false
  let closing = false
  let closePromise = null

  const clamp = () => {
    const width = image.naturalWidth * baseScale * zoom
    const height = image.naturalHeight * baseScale * zoom
    offsetX = Math.max(128 - width / 2, Math.min(width / 2 - 128, offsetX))
    offsetY = Math.max(128 - height / 2, Math.min(height / 2 - 128, offsetY))
  }
  const draw = () => {
    if (!image.complete || !image.naturalWidth) return
    const width = image.naturalWidth * baseScale * zoom
    const height = image.naturalHeight * baseScale * zoom
    clamp()
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#f7eaf0'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 128 + offsetX - width / 2, 128 + offsetY - height / 2, width, height)
  }
  const finish = (cancel = false) => {
    if (closed) return Promise.resolve()
    if (closing) return closePromise || Promise.resolve()
    closing = true
    drag = null
    closePromise = Promise.all([
      animatePresence(overlay, false, { className: 'overlay-presence', duration: 220, remove: true }),
      animatePresence($('.avatar-crop-dialog', overlay), false, { className: 'dialog-presence', duration: 260 }),
    ]).then(() => {
      if (closed) return
      closed = true
      URL.revokeObjectURL(objectUrl)
      if (cancel) onCancel?.()
    })
    return closePromise
  }
  const cleanup = () => { void finish(true) }
  image.onload = () => {
    baseScale = 256 / Math.min(image.naturalWidth, image.naturalHeight)
    draw()
  }
  image.onerror = cleanup
  image.src = objectUrl
  zoomInput.oninput = () => { zoom = Number(zoomInput.value) || 1; draw() }
  stage.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX, offsetY }
    try { stage.setPointerCapture(event.pointerId) } catch {}
  })
  stage.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const rect = canvas.getBoundingClientRect()
    const ratio = canvas.width / Math.max(1, rect.width)
    offsetX = drag.offsetX + (event.clientX - drag.x) * ratio
    offsetY = drag.offsetY + (event.clientY - drag.y) * ratio
    draw()
  })
  const endDrag = () => { drag = null }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)
  $('.avatar-crop-close', overlay).onclick = cleanup
  $('.avatar-crop-cancel', overlay).onclick = cleanup
  confirmButton.onclick = async () => {
    confirmButton.disabled = true
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
      if (!blob) throw new Error('头像裁剪失败')
      const result = await onConfirm(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }))
      if (result !== false) {
        await finish(false)
      } else {
        confirmButton.disabled = false
      }
    } catch (error) {
      confirmButton.disabled = false
      throw error
    }
  }
  document.body.appendChild(overlay)
  animatePresence(overlay, true, { className: 'overlay-presence', duration: 220 })
  animatePresence($('.avatar-crop-dialog', overlay), true, { className: 'dialog-presence', duration: 260 })
  requestAnimationFrame(() => confirmButton.focus())
}

// ---------- 账号视图(修改登录账号、显示名称与密码) ----------

function renderAccount({ backHref = '#/', backLabel = '返回时间轴' } = {}) {
  if (!site.user) return renderLogin()
  clearMain()
  installToTop()
  const currentUsername = site.user.username || site.user.name
  const currentDisplayName = site.user.displayName || site.user.name
  const page = el(`
    <div class="account-page">
      <header class="account-page-header">
        <a class="account-back" href="${backHref}" aria-label="${backLabel}" title="${backLabel}">${icon('arrow-left')}</a>
        <h1 tabindex="-1">个人资料</h1>
      </header>

      <form class="account-section profile-form">
        <h2>个人资料</h2>
        <div class="profile-avatar-row">
          <div class="profile-avatar-slot"></div>
          <div class="profile-avatar-copy"><strong>头像</strong><p>会展示在动态、评论和相册中，访客也可以看到。</p><div class="profile-avatar-actions"><button class="btn-ghost avatar-change" type="button">更换头像</button><button class="btn-ghost avatar-remove" type="button">恢复默认</button></div></div>
          <input class="avatar-file-input" type="file" accept="image/jpeg,image/png,image/webp" hidden />
        </div>
        <label for="account-username">登录账号</label>
        <input id="account-username" name="username" value="${esc(currentUsername)}" maxlength="24" autocomplete="username" aria-describedby="account-username-hint profile-message" required />
        <div class="account-hint" id="account-username-hint">用于登录,长度为 1-24 个字符,不能包含冒号</div>
        <label for="account-display-name">显示名称</label>
        <input id="account-display-name" name="displayName" value="${esc(currentDisplayName)}" maxlength="24" autocomplete="nickname" aria-describedby="account-display-name-hint profile-message" required />
        <div class="account-hint" id="account-display-name-hint">显示在动态和相册中,长度为 1-24 个字符</div>
        <div class="form-message" id="profile-message" aria-live="polite"></div>
        <div class="account-actions">
          <button class="btn" type="submit">保存账户信息</button>
        </div>
      </form>

      <form class="account-section password-form">
        <h2>修改密码</h2>
        <label for="password-username">登录账号</label>
        <input id="password-username" name="username" value="${esc(currentUsername)}" autocomplete="username" readonly />
        <label for="current-password">当前密码</label>
        <input id="current-password" name="oldPassword" type="password" autocomplete="current-password" aria-describedby="password-message" required />
        <label for="new-password">新密码</label>
        <input id="new-password" name="newPassword" type="password" autocomplete="new-password" minlength="6" aria-describedby="new-password-hint password-message" required />
        <label for="confirm-password">确认新密码</label>
        <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="6" aria-describedby="new-password-hint password-message" required />
        <div class="account-hint" id="new-password-hint">新密码至少 6 位</div>
        <div class="form-message" id="password-message" aria-live="polite"></div>
        <div class="account-actions">
          <button class="btn" type="submit">更新密码</button>
        </div>
      </form>
    </div>`)

  if (backHref === '#/settings') {
    $('.account-back', page).onclick = (event) => {
      if (!plainNavigation(event)) return
      event.preventDefault()
      const source = history.state?.profileReturn
      if (source?.route === location.hash && source.from === backHref) history.back()
      else location.replace(backHref)
    }
  }

  const profileForm = $('.profile-form', page)
  const usernameInput = $('[name=username]', profileForm)
  const displayNameInput = $('[name=displayName]', profileForm)
  const profileMessage = $('.form-message', profileForm)
  const avatarSlot = $('.profile-avatar-slot', profileForm)
  const avatarChange = $('.avatar-change', profileForm)
  const avatarRemove = $('.avatar-remove', profileForm)
  const avatarInput = $('.avatar-file-input', profileForm)
  const renderProfileAvatar = () => {
    avatarSlot.innerHTML = ''
    avatarSlot.appendChild(avatarNode(site.user.name, site.user.avatarUrl, 'profile-avatar'))
  }
  renderProfileAvatar()
  const setAvatarBusy = (busy) => {
    avatarChange.disabled = busy
    avatarRemove.disabled = busy
  }
  avatarChange.onclick = () => avatarInput.click()
  avatarInput.onchange = async () => {
    const file = avatarInput.files?.[0]
    avatarInput.value = ''
    if (!file) return
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
      setFormMessage(profileMessage, file.size > 10 * 1024 * 1024 ? '头像不能超过 10MB' : '请选择 JPEG、PNG 或 WebP 图片')
      return
    }
    try {
      await openAvatarCropper(file, async (cropped) => {
        setAvatarBusy(true)
        setFormMessage(profileMessage, '头像上传中…', 'neutral')
        try {
          const form = new FormData()
          form.append('avatar', cropped)
          const result = await api('/api/profile/avatar', { method: 'POST', body: form })
          site.user.avatarUrl = result.avatarUrl || null
          renderUserArea()
          renderProfileAvatar()
          setFormMessage(profileMessage, '头像已更新', 'success')
          return true
        } catch (error) {
          setFormMessage(profileMessage, error.message)
          return false
        } finally {
          setAvatarBusy(false)
        }
      })
    } catch (error) {
      setFormMessage(profileMessage, error.message || '头像处理失败')
      setAvatarBusy(false)
    }
  }
  avatarRemove.onclick = async () => {
    if (!site.user.avatarUrl) { setFormMessage(profileMessage, '当前使用的是文字头像', 'neutral'); return }
    setAvatarBusy(true)
    try {
      await api('/api/profile/avatar', { method: 'DELETE' })
      site.user.avatarUrl = null
      renderUserArea()
      renderProfileAvatar()
      setFormMessage(profileMessage, '已恢复默认头像', 'success')
    } catch (error) {
      setFormMessage(profileMessage, error.message)
    } finally {
      setAvatarBusy(false)
    }
  }
  const passwordForm = $('.password-form', page)
  const passwordUsernameInput = $('[name=username]', passwordForm)
  const oldPasswordInput = $('[name=oldPassword]', passwordForm)
  const newPasswordInput = $('[name=newPassword]', passwordForm)
  const confirmPasswordInput = $('[name=confirmPassword]', passwordForm)
  const passwordMessage = $('.form-message', passwordForm)
  profileForm.onsubmit = async (event) => {
    event.preventDefault()
    setFormMessage(profileMessage, '')
    usernameInput.removeAttribute('aria-invalid')
    displayNameInput.removeAttribute('aria-invalid')
    const newUsername = usernameInput.value.trim()
    const newName = displayNameInput.value.trim()
    if (newUsername === (site.user.username || site.user.name) && newName === (site.user.displayName || site.user.name)) {
      setFormMessage(profileMessage, '账户信息没有变化', 'neutral')
      return
    }
    const submit = $('button[type=submit]', profileForm)
    submit.disabled = true
    try {
      const result = await api('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, displayName: newName }),
      })
      site.user.username = result.username || newUsername
      site.user.displayName = result.displayName ?? result.name ?? newName
      site.user.name = site.user.displayName
      usernameInput.value = site.user.username
      usernameInput.defaultValue = site.user.username
      displayNameInput.value = site.user.name
      displayNameInput.defaultValue = site.user.name
      passwordUsernameInput.value = site.user.username
      passwordUsernameInput.defaultValue = site.user.username
      renderUserArea()
      setFormMessage(profileMessage, '账户信息已更新', 'success')
    } catch (e) {
      setFormMessage(profileMessage, e.message)
      const invalidInput = e.message.includes('登录账号') ? usernameInput : e.message.includes('显示名称') ? displayNameInput : null
      if (invalidInput) {
        invalidInput.setAttribute('aria-invalid', 'true')
        invalidInput.focus()
      }
    } finally {
      submit.disabled = false
    }
  }
  profileForm.oninput = () => {
    usernameInput.removeAttribute('aria-invalid')
    displayNameInput.removeAttribute('aria-invalid')
    setFormMessage(profileMessage, '')
  }

  passwordForm.onsubmit = async (event) => {
    event.preventDefault()
    setFormMessage(passwordMessage, '')
    for (const input of [oldPasswordInput, newPasswordInput, confirmPasswordInput]) input.removeAttribute('aria-invalid')
    const oldPassword = oldPasswordInput.value
    const newPassword = newPasswordInput.value
    const confirmPassword = confirmPasswordInput.value
    if (newPassword !== confirmPassword) {
      setFormMessage(passwordMessage, '两次输入的新密码不一致')
      confirmPasswordInput.setAttribute('aria-invalid', 'true')
      confirmPasswordInput.focus()
      return
    }
    const submit = $('button[type=submit]', passwordForm)
    submit.disabled = true
    try {
      await api('/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      passwordForm.reset()
      setFormMessage(passwordMessage, '密码已更新', 'success')
    } catch (e) {
      setFormMessage(passwordMessage, e.message)
      const invalidInput = e.message === '原密码错误' ? oldPasswordInput : e.message.startsWith('新密码') ? newPasswordInput : null
      if (invalidInput) {
        invalidInput.setAttribute('aria-invalid', 'true')
        invalidInput.focus()
      }
    } finally {
      submit.disabled = false
    }
  }
  passwordForm.oninput = () => {
    for (const input of [oldPasswordInput, newPasswordInput, confirmPasswordInput]) input.removeAttribute('aria-invalid')
    setFormMessage(passwordMessage, '')
  }

  main.appendChild(page)
  $('h1', page).focus()
}

// ---------- 设置视图(登录后可见,即时生效) ----------

function renderSiteSettingsCard() {
  const card = el(`
    <section class="settings-card">
      <h2>站点设置</h2>
      <label>站点名称<input name="title" value="${esc(site.title)}" /></label>
      <label>起始日期(顶栏显示天数)<input name="anniversary" type="date" value="${esc(site.anniversary)}" /></label>
      <label class="row">
        <input name="privateMode" type="checkbox" ${site.privateMode ? 'checked' : ''} />
        <span>私密模式(未登录访客只能看到每条动态中公开的正文和图片)</span>
      </label>
      <div class="form-error"></div>
      <div class="settings-actions">
        <span class="save-tip" hidden>已保存</span>
        <button class="btn save">保存</button>
      </div>
    </section>`)
  const tip = $('.save-tip', card)
  const err = $('.form-error', card)
  $('.save', card).onclick = async () => {
    err.textContent = ''
    try {
      await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: $('[name=title]', card).value,
          anniversary: $('[name=anniversary]', card).value,
          privateMode: $('[name=privateMode]', card).checked,
        }),
      })
      tip.hidden = false
      setTimeout(() => location.reload(), 600)
    } catch (e) {
      err.textContent = e.message
    }
  }
  appendSettingsItem(card)

}

async function renderVideoSettingsCard() {
  const pageHash = location.hash
  const pageHeader = $('.settings-subpage-header', main)
  let config
  try { config = await getVideoUploadConfig() }
  catch (error) { if (location.hash === pageHash && main.contains(pageHeader)) appendSettingsItem(el(`<p class="form-error">${esc(error.message)}</p>`)); return }
  if (location.hash !== pageHash || !main.contains(pageHeader)) return
  const card = el(`<section class="settings-card video-settings">
    <h2>视频压缩</h2>
    <p class="storage-hint">默认先保存原文件，再由后台自动压缩。完成后对比体积和规格，推荐版本自动采用；发布前仍可切换，未采用版本在发布或丢弃草稿时清理。</p>
    <label class="row"><input name="videoEnabled" type="checkbox" ${config.enabled ? 'checked' : ''} /><span>自动压缩视频</span></label>
    <p class="storage-hint">固定档位：1080p 30/60fps 为 25/35MB 每分钟；4K 30/60fps 为 85/120MB。1MB = 1,000,000 字节；预算包含音轨，实际体积随内容变化。</p>
    <p class="storage-hint">保留分辨率与最高 ${esc(String(config.maxFps))}fps，不补低帧率；软件编码使用 Main10、CRF21/22、fast，硬件编码使用独立参数；音轨为 AAC 128kbps。播放需要设备支持 HEVC；压缩属于有损处理，不承诺画质无损。</p>
    <p class="storage-hint">上传中断后重新选择同一原文件可续传；后台任务按检查点恢复。关闭压缩则直接采用原件。</p>
    <div class="storage-status">视频工具：${config.available ? '已就绪' : esc(config.error)}；原文件上限 ${Math.round(config.maxBytes / 1024 / 1024)}MiB</div>
    <div class="form-error" role="status"></div>
    <div class="settings-actions"><span class="save-tip" hidden>已保存</span><button class="btn save" type="button">保存</button></div>
  </section>`)
  const enabled = $('[name=videoEnabled]', card)
  enabled.onchange = () => { $('.save-tip', card).hidden = true }
  $('.save', card).onclick = async () => {
    const button = $('.save', card)
    const error = $('.form-error', card)
    error.textContent = ''
    button.disabled = true
    try {
      await api('/api/uploads/video/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled.checked }) })
      $('.save-tip', card).hidden = false
    } catch (e) { error.textContent = e.message }
    finally { button.disabled = false }
  }
  appendSettingsItem(card)
}

function renderSettingsSection(kind) {
  if (!site.user) return renderLogin()
  clearMain()
  installToTop()
  const titles = { site: '站点设置', ai: 'AI 设置', storage: '图片存储', backup: '备份与恢复' }
  const header = el(`<header class="account-page-header settings-subpage-header"><a class="account-back" href="#/settings" aria-label="返回设置" title="返回设置">${icon('arrow-left')}</a><h1 tabindex="-1">${titles[kind]}</h1></header>`)
  main.appendChild(header)
  if (kind === 'site') { renderSiteSettingsCard(); renderVideoSettingsCard() }
  else if (kind === 'ai') renderAiCards()
  else if (kind === 'backup') renderBackupCard()
  else renderStorageCard()
  $('h1', header).focus()
}

function renderThemeCard() {
  const card = el(`<section class="settings-card theme-card">
    <div class="settings-card-heading"><div><h2>外观</h2><p>浅色、深色，或者跟着系统走。</p></div></div>
    <fieldset class="theme-options"><legend class="sr-only">选择外观</legend></fieldset>
    <p class="theme-help" aria-live="polite">仅用于当前浏览器，刷新后保留。</p>
  </section>`)
  for (const choice of window.JournalTheme.choices) {
    const option = el(`<label class="theme-option" data-palette="${choice.id}">
      <input type="radio" name="theme" value="${choice.id}" ${window.JournalTheme.preference === choice.id ? 'checked' : ''} />
      <span>${choice.name}</span>
    </label>`)
    $('input', option).onchange = () => {
      const saved = window.JournalTheme.set(choice.id)
      $('.theme-help', card).textContent = saved ? `已切换为${choice.name}，刷新后保留。` : '外观已切换；当前浏览器无法保存偏好，刷新后可能恢复原来的设置。'
    }
    $('.theme-options', card).appendChild(option)
  }
  return card
}
window.addEventListener('journal-theme-change', () => {
  document.querySelectorAll('.theme-option input').forEach((input) => { input.checked = input.value === window.JournalTheme.preference })
})

function renderSettings() {
  if (!site.user) return renderLogin()
  clearMain()
  installToTop()
  main.appendChild(el('<header class="page-heading settings-heading"><div><p>让日常，更合心意</p><h1>设置</h1></div></header>'))
  main.appendChild(renderThemeCard())
  const profileCard = el(`<section class="settings-card settings-profile">
    <div class="settings-card-heading settings-profile-heading"><h2>个人资料</h2><a class="btn-ghost settings-profile-edit" href="#/settings/profile">${icon('user')}<span>编辑资料</span></a><p>头像和显示名称会展示给另一位成员及访客。</p></div>
    <div class="settings-profile-summary"><span class="settings-profile-avatar"></span><div><strong class="settings-profile-name"></strong><span class="settings-profile-username"></span></div></div>
  </section>`)
  $('.settings-profile-edit', profileCard).onclick = (event) => {
    if (!plainNavigation(event) || location.hash !== '#/settings') return
    event.preventDefault()
    const target = '#/settings/profile'
    history.pushState({ profileReturn: { route: target, from: '#/settings' } }, '', target)
    route()
  }
  $('.settings-profile-avatar', profileCard).replaceWith(avatarNode(site.user.name, site.user.avatarUrl, 'settings-profile-avatar'))
  $('.settings-profile-name', profileCard).textContent = site.user.name
  $('.settings-profile-username', profileCard).textContent = `登录账号：${site.user.username || site.user.name}`
  main.appendChild(profileCard)

  const notificationCard = el(`<section class="settings-card notification-card">
    <div class="settings-card-heading"><div><h2>通知</h2><p class="notification-intro">评论和回复可以通过浏览器系统通知提醒你。</p></div></div>
    <div class="notification-action-slot"></div>
    <p class="notification-help" aria-live="polite"></p>
  </section>`)
  const notificationAction = browserNotificationAction({ settings: true, help: $('.notification-help', notificationCard) })
  $('.notification-action-slot', notificationCard).appendChild(notificationAction.button)
  activeSettingsCleanup = notificationAction.dispose
  main.appendChild(notificationCard)

  const sections = [
    ['#/settings/site', 'settings', '站点设置', '站名、纪念日和访客可见范围'],
    ['#/settings/ai', 'sparkles', 'AI 设置', '配置 AI 优化与 AI 配图的接口、模型和连接测试'],
    ['#/settings/storage', 'image', '图片存储', '选择本地磁盘或 WebDAV'],
    ['#/settings/backup', 'settings', '备份与恢复', '自动备份到 WebDAV，导入数据库恢复'],
  ]
  for (const [href, iconName, title, description] of sections) {
    main.appendChild(el(`<a class="settings-link settings-card" href="${href}"><span class="settings-link-icon">${icon(iconName)}</span><span class="settings-link-copy"><strong>${title}</strong><small>${description}</small></span><span class="settings-link-arrow">${icon('arrow-right')}</span></a>`))
  }

  const accountActions = el(`<section class="settings-card settings-account-actions"><button class="btn-ghost settings-logout" type="button">${icon('log-out')}<span>退出登录</span></button></section>`)
  $('.settings-logout', accountActions).onclick = async () => {
    const button = $('.settings-logout', accountActions)
    button.disabled = true
    await browserNotifications.disable().catch(() => {})
    await api('/api/logout', { method: 'POST' })
    location.reload()
  }
  main.appendChild(accountActions)
}

function appendSettingsItem(node) {
  main.appendChild(node)
}

function renderBackupCard() {
  const view = createBackupSettings(async ({ safetyBackup }) => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(`compose-draft:${location.origin}:`) || key.startsWith(`compose-draft-id:${location.origin}:`)) localStorage.removeItem(key)
      }
      for (const key of Object.keys(sessionStorage)) if (key.startsWith('compose-draft:')) sessionStorage.removeItem(key)
    } catch { /* 浏览器可能禁用本地存储，服务端恢复结果仍然有效。 */ }
    try {
      const database = await draftFileDb()
      if (database) await new Promise((resolve, reject) => {
        const transaction = database.transaction('files', 'readwrite')
        transaction.objectStore('files').clear()
        transaction.oncomplete = resolve
        transaction.onerror = transaction.onabort = () => reject(transaction.error)
      })
    } catch { /* 缓存不可访问时继续重新登录，旧任务引用已在服务端失效。 */ }
    const notice = `数据库已恢复，请使用导入库中的账号重新登录。恢复前副本：${safetyBackup}`
    try { sessionStorage.setItem('database-restore-notice', notice) } catch { window.alert(notice) }
    site.user = null
    location.hash = '#/login'
    location.reload()
  })
  appendSettingsItem(view.node)
  activeSettingsCleanup = view.dispose
}

// AI 优化与 AI 配图共用一张接口配置卡:共享 API 可各自选模型,也可使用独立 API。
// 两个模块的接口同形(GET/PUT 配置、POST /models、POST /test),文案与额外状态行由调用方给出。
async function createApiConfigCard({ key, title, intro, path, modelHint, extraStatus = '', testMessage, thinking = false }) {
  let s
  try {
    s = await api(path)
  } catch (e) {
    return el(`<div class="empty-tip">${esc(title)}配置读取失败：${esc(e.message)}</div>`)
  }
  const custom = s.mode === 'custom'
  const listId = `${key}-model-list`
  const card = el(`
    <div class="card settings-card">
      <h2>${esc(title)}</h2>
      <div class="storage-status">${intro}</div>
      <div role="radiogroup" aria-label="${esc(title)}配置来源">
        <label class="row"><input name="mode" type="radio" value="shared" ${custom ? '' : 'checked'} /><span>使用已配置的共享 API</span></label>
        <label class="row"><input name="mode" type="radio" value="custom" ${custom ? 'checked' : ''} /><span>配置独立 API</span></label>
      </div>
      <div class="llm-shared" ${custom ? 'hidden' : ''}>
        <div class="llm-global-hint">${s.shared.baseUrl ? `共享接口：${esc(s.shared.baseUrl)} · 默认模型：${esc(s.shared.model || '未设模型')}` : '尚未配置共享接口，可由任一账号首次填写'}</div>
        <label>共享接口地址（OpenAI 兼容）<input name="sharedBaseUrl" value="${esc(s.shared.baseUrl)}" placeholder="https://api.openai.com/v1" /></label>
        <label>共享 API Key<input name="sharedApiKey" type="password" autocomplete="new-password" placeholder="${s.shared.hasApiKey ? '已保存，留空表示不修改' : 'sk-…'}" /></label>
        <label>本次使用模型
          <span class="llm-model-row">
            <input name="sharedModel" list="${listId}" value="${esc(s.sharedModel || '')}" placeholder="${esc(modelHint)}" />
            <button type="button" class="btn-ghost fetch-models">自动获取</button>
          </span>
          <select class="llm-model-picker" name="sharedModelPicker" aria-label="选择共享模型" hidden></select>
        </label>
      </div>
      <div class="llm-custom" ${custom ? '' : 'hidden'}>
        <label>接口地址（OpenAI 兼容）<input name="baseUrl" value="${esc(s.custom.baseUrl)}" placeholder="https://api.openai.com/v1" /></label>
        <label>模型
          <span class="llm-model-row">
            <input name="customModel" list="${listId}" value="${esc(s.custom.model || '')}" placeholder="${esc(modelHint)}" />
            <button type="button" class="btn-ghost fetch-models">自动获取</button>
          </span>
          <select class="llm-model-picker" name="customModelPicker" aria-label="选择独立模型" hidden></select>
        </label>
        <label>API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${s.custom.hasApiKey ? '已保存，留空表示不修改' : 'sk-…'}" /></label>
      </div>
      <datalist id="${listId}"></datalist>
      ${thinking ? `
      <label>思考强度
        <select name="thinking">
          <option value="">不指定(跟随模型默认)</option>
          <option value="middle">中</option>
          <option value="high">高</option>
          <option value="max">最高</option>
        </select>
      </label>
      <div class="storage-hint">选中后会随请求发送 <code>reasoning_effort</code>,值越高思考越久、结果越稳;模型不支持该参数时会直接报错。</div>` : ''}
      ${typeof extraStatus === 'function' ? extraStatus(s) : extraStatus}
      <div class="settings-actions">
        <span class="save-tip" hidden>已保存</span>
        <span class="spacer"></span>
        <button class="btn-ghost test">测试连接</button>
        <button class="btn save">保存</button>
      </div>
      <div class="form-error" role="status" aria-live="polite"></div>
    </div>`)
  const err = $('.form-error', card)
  const thinkingSelect = $('[name=thinking]', card)
  if (thinkingSelect) thinkingSelect.value = s.thinking || ''
  const sharedWrap = $('.llm-shared', card)
  const customWrap = $('.llm-custom', card)
  const selectedMode = () => $('[name=mode]:checked', card).value
  const modelInput = (mode = selectedMode()) => $(`[name=${mode === 'shared' ? 'sharedModel' : 'customModel'}]`, card)
  const modelPicker = (mode = selectedMode()) => $(`[name=${mode === 'shared' ? 'sharedModelPicker' : 'customModelPicker'}]`, card)
  const message = (text, ok) => { err.textContent = text; err.style.color = ok === undefined ? '' : ok ? 'var(--success)' : '#a56a25' }
  const updateMode = () => {
    const shared = selectedMode() === 'shared'
    sharedWrap.hidden = !shared
    customWrap.hidden = shared
  }
  for (const modeBox of card.querySelectorAll('[name=mode]')) modeBox.onchange = updateMode
  for (const picker of card.querySelectorAll('.llm-model-picker')) picker.onchange = () => {
    if (picker.value) modelInput(picker.name === 'sharedModelPicker' ? 'shared' : 'custom').value = picker.value
  }

  const currentPayload = () => {
    const mode = selectedMode()
    const model = modelInput(mode).value
    const payload = mode === 'shared'
      ? { mode, model, sharedBaseUrl: $('[name=sharedBaseUrl]', card).value, sharedApiKey: $('[name=sharedApiKey]', card).value }
      : { mode, model, baseUrl: $('[name=baseUrl]', card).value, apiKey: $('[name=apiKey]', card).value }
    if (thinkingSelect) payload.thinking = thinkingSelect.value
    return payload
  }

  for (const fetchButton of card.querySelectorAll('.fetch-models')) fetchButton.onclick = async () => {
    message('')
    const mode = selectedMode()
    fetchButton.disabled = true
    fetchButton.textContent = '获取中…'
    try {
      const { models } = await api(`${path}/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentPayload()) })
      const list = $(`#${listId}`, card)
      list.innerHTML = ''
      for (const name of models) list.appendChild(el(`<option value="${esc(name)}"></option>`))
      const input = modelInput(mode)
      const picker = modelPicker(mode)
      const names = [...new Set(models.filter((name) => typeof name === 'string' && name.trim()))]
      const options = input.value && !names.includes(input.value) ? [input.value, ...names] : names
      picker.innerHTML = options.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')
      picker.value = input.value
      picker.hidden = options.length === 0
      message(models.length ? `已获取 ${models.length} 个模型` : '接口未返回模型列表', true)
    } catch (e) {
      message(e.message)
    } finally {
      fetchButton.disabled = false
      fetchButton.textContent = '自动获取'
    }
  }

  $('.save', card).onclick = async () => {
    message('')
    try {
      await api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentPayload()) })
      // 已保存的密钥不再回显,输入框留空即表示沿用
      for (const input of card.querySelectorAll('input[type=password]')) {
        if (input.value.trim()) { input.value = ''; input.placeholder = '已保存，留空表示不修改' }
      }
      $('.save-tip', card).hidden = false
    } catch (e) {
      message(e.message)
    }
  }
  $('.test', card).onclick = async () => {
    message('')
    try {
      const result = await api(`${path}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentPayload()) })
      const { text, ok = true } = testMessage(result)
      message(text, ok)
    } catch (e) {
      message(e.message)
    }
  }
  return card
}

async function renderAiCards() {
  appendSettingsItem(await createApiConfigCard({
    key: 'llm',
    title: 'AI 优化',
    intro: '在发布框点「AI 优化」即可调用，凭据只存本服务器。',
    path: '/api/llm',
    modelHint: 'gpt-4o-mini',
    thinking: true,
    testMessage: () => ({ text: '连接成功' }),
  }))

  appendSettingsItem(await createApiConfigCard({
    key: 'image',
    title: 'AI 配图',
    intro: '根据正文生成一张配图，结果先预览再决定是否使用；图片保存到 WebDAV 的 <code>ai-generated/</code> 子目录。',
    path: '/api/image-jobs/config',
    modelHint: 'gpt-image-2',
    extraStatus: (s) => `<div class="storage-status">WebDAV：<b>${s.webdavConnected ? '已连接' : '未连接，AI 配图暂不可用'}</b></div>`,
    testMessage: ({ supportsModel }) => supportsModel
      ? { text: '连接成功，已找到所选模型' }
      : { text: '连接成功，但接口未返回所选模型', ok: false },
  }))
}

// 图片存储配置(本地磁盘 / WebDAV)
async function renderStorageCard() {
  let s
  try {
    s = await api('/api/storage')
  } catch (e) {
    appendSettingsItem(el(`<div class="empty-tip">${esc(e.message)}</div>`))
    return
  }
  const wd = s.webdav
  const counts = Object.fromEntries(s.counts.map((r) => [r.storage, r.count]))
  const card = el(`
    <div class="card settings-card">
      <h2>图片存储</h2>
      <div class="storage-status">
        新图片存到 <b>${s.backend === 'webdav' ? 'WebDAV' : '本地磁盘'}</b>
        <span class="storage-hint">已存:本地 ${counts.local || 0} 张 · WebDAV ${counts.webdav || 0} 张</span>
      </div>
      <label>存储位置
        <select name="backend">
          <option value="local"${s.backend === 'local' ? ' selected' : ''}>本地磁盘(data/uploads)</option>
          <option value="webdav"${s.backend === 'webdav' ? ' selected' : ''}>WebDAV(坚果云等)</option>
        </select>
      </label>
      <label>WebDAV 地址(根目录,以 / 结尾)<input name="url" value="${esc(wd.url)}" placeholder="https://dav.jianguoyun.com/dav/" /></label>
      <label>用户名<input name="username" value="${esc(wd.username)}" placeholder="WebDAV 账号(坚果云为邮箱)" /></label>
      <label>密码<input name="password" type="password" placeholder="${wd.hasPassword ? '已保存,留空表示不修改' : '应用专用密码'}" /></label>
      <label>子目录(根目录下)<input name="folder" value="${esc(wd.folder)}" placeholder="images" /></label>
      <div class="settings-actions">
        <span class="save-tip" hidden>已保存</span>
        <span class="spacer"></span>
        <button class="btn-ghost test">测试连接</button>
        <button class="btn save">保存</button>
      </div>
      <div class="form-error"></div>
    </div>`)
  const storageErr = $('.form-error', card)

  const save = (backend) =>
    api('/api/storage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backend,
        url: $('[name=url]', card).value,
        username: $('[name=username]', card).value,
        password: $('[name=password]', card).value,
        folder: $('[name=folder]', card).value,
      }),
    })

  $('.save', card).onclick = async () => {
    storageErr.textContent = ''
    storageErr.style.color = ''
    try {
      await save($('[name=backend]', card).value)
      $('.save-tip', card).hidden = false
      setTimeout(renderSettings, 600)
    } catch (e) {
      storageErr.textContent = e.message
    }
  }
  $('.test', card).onclick = async () => {
    storageErr.textContent = ''
    storageErr.style.color = ''
    try {
      await api('/api/storage/webdav/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: $('[name=url]', card).value,
          username: $('[name=username]', card).value,
          password: $('[name=password]', card).value,
          folder: $('[name=folder]', card).value,
        }),
      })
      storageErr.textContent = '连接成功'
      storageErr.style.color = '#2a9d4a'
    } catch (e) {
      storageErr.textContent = e.message
      storageErr.style.color = '#c33'
    }
  }
  appendSettingsItem(card)
}

// ---------- 顶栏与路由 ----------

// 站内通知铃铛:轮询未读评论,点开即标记已读,点通知项跳到对应动态并高亮评论
let notifyTimer = null

function notificationTarget(postId, commentId) {
  pendingCommentFocus = { postId, commentId }
  const target = `#/post/${postId}?comment=${commentId}`
  if (location.hash === target) route()
  else location.hash = target
  window.focus?.()
}

// 两个通知入口仅订阅共享状态，权限、查询与推送操作统一由模块管理。
function browserNotificationAction({ settings = false, help = null } = {}) {
  const button = el(settings
    ? `<button class="btn-ghost notification-toggle" type="button">${icon('bell')}<span></span></button>`
    : `<button class="dropdown-item browser-notify" type="button">${icon('bell')}<span></span></button>`)
  const label = $('span', button)
  const dispose = browserNotifications.subscribe((state) => {
    label.textContent = state.label
    button.disabled = !state.supported || state.permission === 'denied' || state.busy
    button.setAttribute('aria-busy', String(state.busy))
    button.setAttribute('aria-pressed', String(state.permission === 'granted' && state.subscribed === true))
    button.title = state.help
    if (help) {
      help.textContent = state.help
      if (!settings) help.hidden = !state.error
    }
  })
  // 错误已广播到两个入口；不在单个按钮上另存一份状态。
  button.onclick = () => { void browserNotifications.toggle().catch(() => {}) }
  return { button, dispose }
}

function renderNotifyBell() {
  const bell = el(`
    <div class="bell-menu">
      <button class="bell-btn" aria-haspopup="true" aria-expanded="false" title="评论通知" aria-label="评论通知">${icon('bell')}<span class="bell-badge" hidden></span></button>
      <div class="dropdown bell-dropdown" hidden></div>
    </div>`)
  const btn = $('.bell-btn', bell)
  const badge = $('.bell-badge', bell)
  const drop = $('.bell-dropdown', bell)
  let items = []

  async function refresh() {
    try {
      items = (await api('/api/notifications')).items
    } catch { return false } // 会话过期等,静默跳过本轮
    badge.textContent = items.length > 9 ? '9+' : String(items.length)
    badge.hidden = items.length === 0
    return true
  }

  function renderList() {
    drop.innerHTML = ''
    if (items.length === 0) {
      drop.appendChild(el('<div class="bell-empty">暂无新评论</div>'))
      return
    }
    for (const it of items) {
      const excerpt = it.content.length > 40 ? it.content.slice(0, 40) + '…' : it.content
      const node = el(`
        <button class="bell-item" type="button">
          <span class="bell-item-line"><b>${esc(it.author)}</b> ${it.reply_to_me ? '回复了你' : '评论了'}:${esc(excerpt)}</span>
          <small>${formatTime(it.created_at)}${it.post_excerpt ? ` · 动态:${esc(it.post_excerpt.slice(0, 20))}` : ''}</small>
        </button>`)
      node.onclick = () => {
        btn.setAttribute('aria-expanded', 'false')
        animatePresence(drop, false, { className: 'menu-presence', duration: 180 })
        notificationTarget(it.post_id, it.id)
      }
      drop.appendChild(node)
    }
  }

  btn.onclick = async (e) => {
    e.stopPropagation()
    const open = drop.hidden || !drop.classList.contains('menu-presence-present') || drop.classList.contains('menu-presence-closing')
    if (open) {
      closeDropdowns(drop)
      btn.setAttribute('aria-expanded', 'true')
      renderList()
      animatePresence(drop, true, { className: 'menu-presence', duration: 180 })
      const refreshed = await refresh()
      renderList()
      // 打开即视为已读:清角标并推进服务端水位线,列表本次仍保留供点击
      if (refreshed && !badge.hidden) {
        badge.hidden = true
        api('/api/notifications/read', { method: 'POST' }).catch(() => {})
      }
      return
    }
    btn.setAttribute('aria-expanded', 'false')
    animatePresence(drop, false, { className: 'menu-presence', duration: 180 })
  }
  drop.onclick = (e) => e.stopPropagation()

  refresh()
  clearInterval(notifyTimer)
  notifyTimer = setInterval(refresh, 60 * 1000)
  return bell
}

function renderUserArea() {
  activeUserNotificationCleanup?.()
  activeUserNotificationCleanup = null
  const area = $('#userArea')
  area.innerHTML = ''
  if (!site.user) {
    area.classList.add('guest')
    area.appendChild(el('<a href="#/login">登录</a>'))
    return
  }
  area.classList.remove('guest')
  area.appendChild(renderNotifyBell())
  // 头像 + 下拉菜单:设置 / 退出
  const menu = el(`
    <div class="user-menu">
      <button class="avatar-btn" aria-haspopup="true" aria-expanded="false">
        <span class="user-avatar-slot"></span>
      </button>
      <div class="dropdown" hidden>
        <div class="dropdown-name">${esc(site.user.name)}</div>
        <div class="browser-notify-slot"></div>
        <p class="notification-help browser-notify-help" aria-live="polite" hidden></p>
        <a href="#/account" class="dropdown-item">${icon('user')}<span>个人资料</span></a>
        <a href="#/settings" class="dropdown-item">${icon('settings')}<span>设置</span></a>
        <button class="dropdown-item logout">${icon('log-out')}<span>退出登录</span></button>
      </div>
    </div>`)
  const btn = $('.avatar-btn', menu)
  const drop = $('.dropdown', menu)
  $('.user-avatar-slot', menu).replaceWith(avatarNode(site.user.name, site.user.avatarUrl, 'small'))
  const notificationAction = browserNotificationAction({ help: $('.browser-notify-help', menu) })
  $('.browser-notify-slot', menu).replaceWith(notificationAction.button)
  activeUserNotificationCleanup = notificationAction.dispose
  btn.onclick = (e) => {
    e.stopPropagation()
    const open = drop.hidden || !drop.classList.contains('menu-presence-present') || drop.classList.contains('menu-presence-closing')
    if (open) closeDropdowns(drop)
    btn.setAttribute('aria-expanded', String(open))
    animatePresence(drop, open, { className: 'menu-presence', duration: 180 })
  }
  menu.querySelectorAll('.dropdown-item[href]').forEach((a) => (a.onclick = () => closeDropdowns()))
  $('.logout', menu).onclick = async () => {
    // 先退订再退出:退订接口需要登录态,且不能让已登出的账号继续往这台设备推通知
    await browserNotifications.disable().catch(() => {})
    await api('/api/logout', { method: 'POST' })
    location.reload()
  }
  area.appendChild(menu)
}

function plainNavigation(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function route() {
  if (!site) return
  const hash = location.hash || '#/'
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = a.getAttribute('href') === hash || (a.dataset.nav === 'timeline' && hash.startsWith('#/post/'))
    a.classList.toggle('active', active)
    if (active) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })
  document.querySelectorAll('[data-mobile-nav]').forEach((a) => {
    const target = a.dataset.mobileNav === 'timeline' ? '#/' : a.dataset.mobileNav === 'gallery' ? '#/gallery' : '#/settings'
    const active = hash === target || (a.dataset.mobileNav === 'settings' && (hash === '#/account' || hash.startsWith('#/settings/'))) || (a.dataset.mobileNav === 'timeline' && hash.startsWith('#/post/'))
    a.classList.toggle('active', active)
    if (active) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })
  if (hash === '#/login') return site.user ? (location.hash = '#/') : renderLogin()
  if (hash === '#/account') return renderAccount()
  if (hash === '#/settings/profile') return renderAccount({ backHref: '#/settings', backLabel: '返回设置' })
  const settingsMatch = hash.match(/^#\/settings\/(site|ai|storage|backup)$/)
  if (settingsMatch) return renderSettingsSection(settingsMatch[1])
  if (hash === '#/settings') return renderSettings()
  const postMatch = hash.match(/^#\/post\/(\d+)(?:\?comment=(\d+))?$/)
  if (postMatch) {
    if (postMatch[2]) pendingCommentFocus = { postId: Number(postMatch[1]), commentId: Number(postMatch[2]) }
    return renderSinglePost(Number(postMatch[1]))
  }
  // 私密模式下,未登录访客:相册是纯图聚合,不可见;时间轴文本可见、图片隐藏
  if (hash === '#/gallery') {
    if (site.privateMode && !site.user) { location.hash = '#/'; return }
    return renderGallery()
  }
  renderTimeline()
}

// 日期分隔条要吸顶在顶栏下沿,需要顶栏的实测高度:窄屏 .header-inner 会 flex-wrap 换行变高,
// 站名随设置变化也会影响高度,写死不可靠。.site-header 自带 padding-top: env(safe-area-inset-top),
// 所以实测高度已覆盖安全区,CSS 侧不必再叠 env()。
function trackHeaderHeight() {
  const header = $('.site-header')
  const sync = () => document.documentElement.style.setProperty('--header-h', `${Math.round(header.getBoundingClientRect().height)}px`)
  sync()
  new ResizeObserver(sync).observe(header)
}

// 顶栏默认完全透明,滚过页面顶端后才淡入材质(Apple 官网里内容滚到导航下面才出现材质的那种做法)。
// 用 1px 哨兵 + IntersectionObserver 判断,不加 scroll 监听、无需节流。
function trackHeaderMaterial() {
  const header = $('.site-header')
  const sentinel = el('<div class="top-material-sentinel" aria-hidden="true"></div>')
  document.body.prepend(sentinel)
  new IntersectionObserver(([entry]) => header.classList.toggle('is-scrolled', !entry.isIntersecting)).observe(sentinel)
}

async function init() {
  site = await api('/api/site')
  document.title = site.title
  $('meta[name="apple-mobile-web-app-title"]').content = site.title
  $('.site-name').textContent = site.title
  $('.site-heart').innerHTML = icon('heart')
  trackHeaderHeight()
  trackHeaderMaterial()
  startDayProgress()
  if ('serviceWorker' in navigator) {
    // 推送订阅要求 registration 已激活,统一等到 ready 再交给通知开关使用
    serviceWorkerRegistration = navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => { void browserNotifications.refresh(); return registration })
      .catch(() => null)
  }
  browserNotifications.start()
  renderUserArea()
  document.querySelectorAll('.mobile-nav [data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon) })
  $('.mobile-compose').onclick = (event) => {
    event.preventDefault()
    if (!site.user) {
      location.hash = '#/login'
      return
    }
    openComposerModal(null, event.currentTarget)
  }
  route()
  try {
    const notice = sessionStorage.getItem('database-restore-notice')
    if (notice) {
      const message = el('<p class="storage-hint" role="status"></p>')
      message.textContent = notice
      main.prepend(message)
      sessionStorage.removeItem('database-restore-notice')
    }
  } catch { /* 浏览器未启用会话存储时仍可正常登录。 */ }
  if (site.user) void browserNotifications.autoEnable().catch(() => {})
}

window.addEventListener('hashchange', route)

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-nav], a[data-mobile-nav], a.site-title')
  if (!link) return
  const target = link.getAttribute('href')
  if (!target) return
  if (location.hash === target) {
    event.preventDefault()
    window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
})

init()
