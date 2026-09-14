// 前端逻辑:hash 路由 + 时间轴 / 相册 / 登录 / 账号 / 设置视图
import { attachMdToolbar, attachEmojiButton } from '/vendor/md-toolbar.js'
import { icon } from '/vendor/icons.js'
import { animatePresence, attachSheetMotion } from '/js/sheet-motion.js'
import { attachComposerViewport } from '/js/composer-viewport.js'
import { api, streamSse, uploadWithProgress, formatBytes, el, esc, setFormMessage, avatarColor, parseTime, formatTime, dateLabel } from '/js/utils.js'
import { openLightbox, closeLightbox } from '/js/lightbox.js'
import { groupMediaFiles, isVideoFile, readVideoPoster, formatDuration, videoContentType } from '/js/media.js'
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
let serviceWorkerRegistration = null
const SERVICE_WORKER_READY_TIMEOUT_MS = 5000
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
  if (!db || !file._id) return
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
  if (trigger) {
    const triggerRect = trigger.getBoundingClientRect()
    const dialogRect = dialog.getBoundingClientRect()
    if (dialogRect.width && dialogRect.height) {
      dialog.style.transformOrigin = `${triggerRect.left + triggerRect.width / 2 - dialogRect.left}px ${triggerRect.top + triggerRect.height / 2 - dialogRect.top}px`
    }
  }
  document.body.classList.add('modal-open')
  for (const { node } of background) node.inert = true
  activeComposerModal = { close: closeModal, overlay }
  disposeViewport = attachComposerViewport(overlay)
  motion = attachSheetMotion(dialog, overlay, grabHandle, finishClose)
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

// 切换视图即清空主区域;未进过视口的观察目标随之作废,避免观察表越积越长
function clearMain() {
  activeComposerModal?.close?.(true)
  closeLightbox(true)
  closePostMenu(true)
  closeDropdowns(null, true)
  revealObserver.disconnect()
  for (const observer of timelineObservers) observer.disconnect()
  timelineObservers = []
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

async function normalizeHeic(file) {
  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' ||
    /\.(heic|heif)$/i.test(file.name)
  if (!isHeic) return file
  const convert = await loadHeic2any()
  const blob = await convert({ blob: file, toType: 'image/jpeg', quality: 0.9 })
  if (!blob || blob.size === 0) throw new Error('HEIC 图片转换失败,请改用 JPEG/PNG')
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
}

async function compressImage(file) {
  if (file.type === 'image/gif' || file.size < 300 * 1024) return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
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
          <span class="ai-tools-label">AI 工具</span>
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
      <input class="album-input" type="file" accept="image/*,video/*" multiple hidden />
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
    statusEl.textContent = '生成中…'
    polishAbort = new AbortController()
    setPolishState(true)
    try {
      await streamSse('/api/llm/polish', { text }, (evt) => {
        if (!evt.delta) return
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
  const savedDraft = readComposeState(draftId) || {}
  let imageTask = null
  let imageJobId = savedDraft.imageJobId || ''
  let imagePollTimer = null
  let disposed = false
  const draftState = () => ({
    content: textarea.value,
    publicText: $('[name=publicText]', card)?.checked ?? false,
    publicImages: $('[name=publicImages]', card)?.checked ?? false,
    files: newFiles.map((file) => ({
      id: file._id, name: file.name || '', type: file.type || '', status: file._status,
      filename: file._name || '', jobId: file._jobId || '',
      kind: file._kind || 'image', poster: file._poster || '', duration: file._duration || null,
      motion: file._motion?._name || '', motionStatus: file._motion?._status || '',
    })),
    keep: keepImages.map((image) => image.id),
    imageJobId: imageTask?.id || savedDraft.imageJobId || '',
  })
  const persistDraft = () => { if (!disposed) saveComposeState(draftId, draftState()) }
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

  // 恢复已上传图片和 IndexedDB 中尚未处理完的原文件。
  ;(async () => {
    const restoredIds = new Set()
    for (const saved of Array.isArray(savedDraft.files) ? savedDraft.files : []) {
      if (!saved.filename) continue
      const kind = saved.kind || 'image'
      // 视频的缩略图只能是它的封面帧;拿不到封面就留空,渲染成中性底而不是裂图
      const thumb = kind === 'video' ? saved.poster : saved.filename
      const file = {
        _id: saved.id || newDraftId(), _name: saved.filename, _status: 'done', _jobId: saved.jobId || '',
        name: saved.name, type: saved.type, _kind: kind, _poster: saved.poster || '',
        _duration: saved.duration || null,
        _url: thumb ? `/api/drafts/${encodeURIComponent(draftId)}/preview/${encodeURIComponent(thumb)}` : '',
      }
      if (saved.motion) file._motion = { _id: newDraftId(), name: '', _status: 'done', _name: saved.motion }
      newFiles.push(file)
      restoredIds.add(file._id)
    }
    const blobs = await loadDraftFiles(draftId)
    for (const file of blobs) {
      if (restoredIds.has(file._id)) continue
      newFiles.push(file)
      processFile(file)
    }
    renderPreviews()
    updatePublishGuard()
    persistDraft()
  })()

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
    disposed = true
    clearInterval(imagePollTimer)
    imagePollTimer = null
    polishAbort?.abort()
    polishAbort = null
    // 关闭编辑器时，未加入发布内容的 AI 结果没有保留价值；运行中的任务也一并取消。
    if (imageJobId && !newFiles.some((file) => file._jobId === imageJobId)) {
      api(`/api/image-jobs/${encodeURIComponent(imageJobId)}`, { method: 'DELETE' }).catch(() => {})
    }
  }
  card.dispose = dispose

  const STATUS_TEXT = { processing: '处理中', uploading: '上传中', generating: '生成中' }

  async function waitForVideoUpload(uploadId) {
    const deadline = Date.now() + 30 * 60 * 1000
    while (Date.now() < deadline) {
      const state = await api(`/api/uploads/video/${encodeURIComponent(uploadId)}`)
      if (state.status === 'done') return state
      if (state.status === 'failed') throw new Error(state.error || '视频保存失败')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('视频保存超时，请稍后在草稿中确认')
  }

  async function uploadVideoFile(file, onProgress) {
    const uploaded = await uploadWithProgress(`/api/uploads/video?draftId=${encodeURIComponent(draftId)}`, file, {
      headers: { 'Content-Type': videoContentType(file) },
      onProgress,
    })
    if (uploaded.status === 'saving' && uploaded.uploadId) return waitForVideoUpload(uploaded.uploadId)
    if (uploaded.filename) return uploaded
    throw new Error(uploaded.error || '视频上传没有返回结果')
  }

  // 视频不压缩不转码:先抽一帧做封面(列表只加载封面,不会为了显示格子去拉视频),
  // 再把原文件按原始字节流上传。大文件刻意不写进 IndexedDB 草稿缓存 —— 手机浏览器配额撑不住 200MB 视频。
  async function processVideo(file) {
    file._kind = 'video'
    file._status = 'processing'
    persistDraft()
    renderPreviews()
    updatePublishGuard()
    try {
      const { duration, poster } = await readVideoPoster(file)
      file._duration = duration
      if (poster) {
        file._posterUrl = URL.createObjectURL(poster)
        file._url = file._posterUrl
        const form = new FormData()
        form.append('image', poster)
        form.append('draftId', draftId)
        const uploaded = await api('/api/uploads', { method: 'POST', body: form })
        file._poster = uploaded.filename
      }
      file._status = 'uploading'
      file._progress = { loaded: 0, total: file.size, phase: 'uploading' }
      renderPreviews()
      let lastPaint = 0
      const uploaded = await uploadVideoFile(file, ({ loaded, total }) => {
        file._progress = { loaded, total: total || file.size, phase: 'uploading' }
        const now = performance.now()
        if (now - lastPaint < 100) return
        lastPaint = now
        renderPreviews()
      })
      file._progress = { loaded: uploaded.size || file.size, total: uploaded.size || file.size, phase: 'saving' }
      renderPreviews()
      file._name = uploaded.filename
      file._status = 'done'
      file._progress = null
    } catch (e) {
      file._status = 'error'
      file._errMsg = e.message || '视频处理失败'
    }
    renderPreviews()
    updatePublishGuard()
    persistDraft()
  }

  // 实况图的配对视频:跟着静帧一起传,发布时用文件名把两者挂在一起
  async function attachMotion(still, motionFile) {
    still._motion = { _id: newDraftId(), name: motionFile.name, _status: 'uploading' }
    persistDraft()
    renderPreviews()
    updatePublishGuard()
    try {
      still._motion._progress = { loaded: 0, total: motionFile.size, phase: 'uploading' }
      renderPreviews()
      let lastPaint = 0
      const uploaded = await uploadVideoFile(motionFile, ({ loaded, total }) => {
        still._motion._progress = { loaded, total: total || motionFile.size, phase: 'uploading' }
        const now = performance.now()
        if (now - lastPaint < 100) return
        lastPaint = now
        renderPreviews()
      })
      still._motion._progress = { loaded: uploaded.size || motionFile.size, total: uploaded.size || motionFile.size, phase: 'saving' }
      renderPreviews()
      still._motion._name = uploaded.filename
      still._motion._status = 'done'
      still._motion._progress = null
    } catch (e) {
      still._motion._status = 'error'
      still._motion._errMsg = e.message || '实况视频上传失败'
    }
    renderPreviews()
    updatePublishGuard()
    persistDraft()
  }

  // 选完图立刻处理(HEIC 转码 + 压缩)并上传到存储后端,发布时只提交文件名
  async function processFile(file) {
    file._id ||= newDraftId()
    file._kind = 'image'
    await saveDraftFile(draftId, file)
    file._status = 'processing'
    persistDraft()
    renderPreviews()
    updatePublishGuard()
    try {
      const normalized = await normalizeHeic(file)
      const compressed = await compressImage(normalized)
      file._url = URL.createObjectURL(compressed)
      file._status = 'uploading'
      renderPreviews()
      const form = new FormData()
      form.append('image', compressed)
      form.append('draftId', draftId)
      const { filename } = await api('/api/uploads', { method: 'POST', body: form })
      file._name = filename
      file._status = 'done'
      await removeDraftFile(draftId, file._id)
      persistDraft()
    } catch (e) {
      file._status = 'error'
      file._errMsg = e.message || '处理失败'
    }
    renderPreviews()
    updatePublishGuard()
    persistDraft()
  }

  function uploadProgressText(item) {
    const progress = item._progress
    if (progress?.total > 0) {
      const label = progress.phase === 'saving' ? '正在保存到 WebDAV' : '上传中'
      return `${label} ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
    }
    return STATUS_TEXT[item._status] || '上传中'
  }

  function renderPreviews() {
    previews.innerHTML = ''
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
    }
  }

  // 发布守卫:任一媒体(含实况配对视频)还在处理或上传中则禁用发布
  const MEDIA_PENDING = ['processing', 'uploading']
  function updatePublishGuard() {
    const pending = newFiles.some((f) => MEDIA_PENDING.includes(f._status) || MEDIA_PENDING.includes(f._motion?._status))
    const generating = imageTask && ['queued', 'running', 'uploading'].includes(imageTask.status)
    submitBtn.disabled = pending || generating
    if (pending) submitBtn.textContent = '图片上传中…'
    else if (generating) submitBtn.textContent = 'AI 配图生成中…'
    else submitBtn.textContent = post ? '保存' : '发布'
  }
  renderPreviews()
  updatePublishGuard()

  $('.pick', card).onclick = () => fileInput.click()
  $('.camera', card).onclick = () => cameraInput.click()
  const handleFiles = (input) => {
    // 先取出文件再清空 input(清空 value 会同时清掉 input.files)
    const picked = [...input.files]
    input.value = ''
    // 实况图 = 同名主干上的静帧 + 配对视频。分组在改名之前按原始文件名做,
    // 因为 HEIC 转码与压缩都会把文件名换成 .jpg,之后再配就配不上了。
    const groups = groupMediaFiles(picked)
    const queued = []
    for (const group of groups) {
      if (group.video) {
        newFiles.push(group.video)
        queued.push(() => processVideo(group.video))
        continue
      }
      if (!group.still) continue
      newFiles.push(group.still)
      queued.push(() => processFile(group.still))
      if (group.motion) queued.push(() => attachMotion(group.still, group.motion))
    }
    renderPreviews()
    updatePublishGuard()
    // 处理与上传异步进行,完成后各自刷新状态
    for (const task of queued) task()
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
    if (newFiles.some((f) => MEDIA_PENDING.includes(f._status) || MEDIA_PENDING.includes(f._motion?._status))) return
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
    input = el('<input class="comment-input" placeholder="写条评论…" maxlength="500" />')
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
function mediaTile(media, alt = '') {
  const poster = media.type === 'video' ? (media.poster || '') : media.url
  const tile = el(`<button class="media-tile" type="button">${poster ? `<img src="${esc(poster)}" alt="${esc(alt)}" loading="lazy" />` : ''}</button>`)
  if (!poster) tile.classList.add('no-poster')
  if (media.type === 'video') {
    tile.classList.add('is-video')
    tile.append(el(`<span class="media-play" aria-hidden="true">${icon('play')}</span>`))
    if (media.duration) tile.append(el(`<span class="media-duration">${formatDuration(media.duration)}</span>`))
  } else if (media.live) {
    tile.classList.add('is-live')
    tile.append(el('<span class="media-live" aria-hidden="true"><span class="lb-live-dot"></span>LIVE</span>'))
  }
  return tile
}

// 时间轴与相册共用:按顺序渲染格子并把灯箱串起来
function renderMediaGrid(grid, list, alt = '') {
  list.forEach((media, i) => {
    const tile = mediaTile(media, alt)
    tile.onclick = () => openLightbox(list, i, tile)
    grid.appendChild(tile)
  })
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
  $('.write-trigger', heading)?.addEventListener('click', (event) => openComposerModal(null, event.currentTarget))

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
        const tile = mediaTile(media, caption)
        tile.classList.add('gallery-photo')
        tile.append(el(`<span>${esc(caption)}</span>`))
        tile.setAttribute('aria-label', `查看${media.type === 'video' ? '视频' : '照片'}：${caption}`)
        tile.onclick = () => openLightbox(images, images.indexOf(media), tile)
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

function renderAccount() {
  if (!site.user) return renderLogin()
  clearMain()
  installToTop()
  const currentUsername = site.user.username || site.user.name
  const currentDisplayName = site.user.displayName || site.user.name
  const page = el(`
    <div class="account-page">
      <header class="account-page-header">
        <a class="account-back" href="#/" aria-label="返回时间轴" title="返回时间轴">${icon('arrow-left')}</a>
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

function renderSettingsSection(kind) {
  if (!site.user) return renderLogin()
  clearMain()
  installToTop()
  const titles = { site: '站点设置', ai: 'AI 设置', storage: '图片存储' }
  const header = el(`<header class="account-page-header settings-subpage-header"><a class="account-back" href="#/settings" aria-label="返回设置" title="返回设置">${icon('arrow-left')}</a><h1 tabindex="-1">${titles[kind]}</h1></header>`)
  main.appendChild(header)
  if (kind === 'site') renderSiteSettingsCard()
  else if (kind === 'ai') renderAiCards()
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
    <div class="settings-card-heading"><div><h2>个人资料</h2><p>头像和显示名称会展示给另一位成员及访客。</p></div><a class="btn-ghost" href="#/account">${icon('user')}<span>编辑资料</span></a></div>
    <div class="settings-profile-summary"><span class="settings-profile-avatar"></span><div><strong class="settings-profile-name"></strong><span class="settings-profile-username"></span></div></div>
  </section>`)
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
  $('.notification-action-slot', notificationCard).appendChild(notificationAction)
  main.appendChild(notificationCard)

  const sections = [
    ['#/settings/site', 'settings', '站点设置', '站名、纪念日和访客可见范围'],
    ['#/settings/ai', 'sparkles', 'AI 设置', '配置 AI 优化与 AI 配图的接口、模型和连接测试'],
    ['#/settings/storage', 'image', '图片存储', '选择本地磁盘或 WebDAV'],
  ]
  for (const [href, iconName, title, description] of sections) {
    main.appendChild(el(`<a class="settings-link settings-card" href="${href}"><span class="settings-link-icon">${icon(iconName)}</span><span class="settings-link-copy"><strong>${title}</strong><small>${description}</small></span><span class="settings-link-arrow">${icon('arrow-right')}</span></a>`))
  }

  const accountActions = el(`<section class="settings-card settings-account-actions"><button class="btn-ghost settings-logout" type="button">${icon('log-out')}<span>退出登录</span></button></section>`)
  $('.settings-logout', accountActions).onclick = async () => {
    const button = $('.settings-logout', accountActions)
    button.disabled = true
    await disablePush().catch(() => {})
    await api('/api/logout', { method: 'POST' })
    location.reload()
  }
  main.appendChild(accountActions)
}

function appendSettingsItem(node) {
  main.appendChild(node)
}

// AI 优化与 AI 配图共用一张接口配置卡:共享 API 可各自选模型,也可使用独立 API。
// 两个模块的接口同形(GET/PUT 配置、POST /models、POST /test),文案与额外状态行由调用方给出。
async function createApiConfigCard({ key, title, intro, path, modelHint, extraStatus = '', testMessage }) {
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
    return mode === 'shared'
      ? { mode, model, sharedBaseUrl: $('[name=sharedBaseUrl]', card).value, sharedApiKey: $('[name=sharedApiKey]', card).value }
      : { mode, model, baseUrl: $('[name=baseUrl]', card).value, apiKey: $('[name=apiKey]', card).value }
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

// 浏览器系统通知走 Web Push:订阅交给服务端保存,新评论由服务端直接推给推送服务,
// 页面切后台或整个关掉都能收到(轮询做不到这点),展示由 sw.js 的 push 事件负责。

// applicationServerKey 只接受二进制,服务端给的是 base64url 公钥
function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0))
}

async function readyServiceWorker() {
  let timer = null
  let registration
  try {
    registration = await Promise.race([
      Promise.resolve(serviceWorkerRegistration),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return registration
}

async function currentPushSubscription() {
  const registration = await readyServiceWorker()
  return registration?.pushManager ? registration.pushManager.getSubscription() : null
}

async function savePushSubscription(subscription) {
  await api('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  })
}

async function enablePush() {
  // 权限请求必须紧跟用户点击,移动端 Chrome 会拒绝跨过异步等待后的请求。
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') return false
  const registration = await readyServiceWorker()
  if (!registration?.pushManager) throw new Error('通知服务尚未就绪')
  const { key } = await api('/api/push/key')
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(key),
  })
  try {
    await savePushSubscription(subscription)
  } catch (e) {
    // 服务端没存下就等于没开,留着浏览器侧的订阅只会让开关显示成已开启
    await subscription.unsubscribe()
    throw e
  }
  return true
}

// 登录后自动尝试一次通知订阅。浏览器若要求用户手势或策略阻止,保留菜单中的手动开关。
async function autoEnablePush() {
  if (!site?.user || !window.isSecureContext ||
      !('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator) ||
      Notification.permission === 'denied') return
  try {
    const existing = await currentPushSubscription()
    if (existing) {
      // 浏览器订阅是设备级的,换账号后不能只看见已有订阅就返回,必须重新绑定当前用户。
      await savePushSubscription(existing)
      return
    }
    // 未决定时不在页面初始化阶段弹授权框,只由通知按钮触发。
    if (Notification.permission === 'default') return
    await enablePush()
  } catch {
    // 自动请求失败时不弹出错误,用户仍可从头像菜单手动开启。
  }
}

async function disablePush() {
  const subscription = await currentPushSubscription()
  if (!subscription) return
  let failure = null
  try {
    await api('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
  } catch (e) {
    failure = e
  } finally {
    // 服务端失败也必须清掉本地订阅,否则下一个登录账号会复用旧账号的 endpoint。
    try { await subscription.unsubscribe() } catch (e) { if (!failure) failure = e }
  }
  if (failure) throw failure
}

function notificationEnvironment() {
  if (!window.isSecureContext) return { supported: false, label: '通知需要 HTTPS', help: '请使用 HTTPS 地址打开此站点。' }
  const ios = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform))
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone
  if (ios && !standalone) return { supported: false, label: '请添加到主屏幕后开启', help: 'iPhone 请从分享菜单添加到主屏幕，再从主屏幕打开此站点。' }
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    return { supported: false, label: '浏览器不支持通知', help: '请更新浏览器，或使用支持 Web Push 的浏览器。' }
  }
  return { supported: true, help: '允许后，另一位成员发表评论时会提醒你。' }
}

function browserNotificationAction({ settings = false, help = null } = {}) {
  const button = el(settings
    ? `<button class="btn-ghost notification-toggle" type="button" disabled>${icon('bell')}<span>开启浏览器通知</span></button>`
    : `<button class="dropdown-item browser-notify" type="button" disabled>${icon('bell')}<span>开启浏览器通知</span></button>`)
  const label = $('span', button)
  const environment = notificationEnvironment()
  const setHelp = (message) => { if (help) help.textContent = message }
  if (!environment.supported) {
    label.textContent = environment.label
    setHelp(environment.help)
    return button
  }
  if (Notification.permission === 'denied') {
    label.textContent = '通知权限已被阻止'
    setHelp('请在浏览器的站点设置中允许通知，再回到这里重试。')
    return button
  }

  const sync = async () => {
    try {
      const subscribed = Boolean(await currentPushSubscription())
      label.textContent = subscribed ? '关闭浏览器通知' : '开启浏览器通知'
      setHelp(subscribed ? '已开启。另一位成员发表评论时会提醒你。' : environment.help)
    } catch {
      label.textContent = '通知暂时不可用'
      setHelp('Service Worker 尚未就绪，请稍后重试。')
    } finally {
      button.disabled = false
    }
  }
  // 状态查询可以后台完成,按钮必须立即可点以保留移动端的用户手势。
  button.disabled = false
  button.onclick = async () => {
    button.disabled = true
    label.textContent = '处理中…'
    try {
      // permission 为 default 时不能先 await getSubscription,否则会丢失移动端用户手势。
      if (Notification.permission === 'default') {
        if (!await enablePush()) setHelp('未获得通知权限，可在浏览器站点设置中重新允许。')
      } else if (await currentPushSubscription()) await disablePush()
      else if (!await enablePush()) setHelp('未获得通知权限，可在浏览器站点设置中重新允许。')
    } catch (e) {
      setHelp(e.message || '无法开启通知，请稍后重试。')
    }
    await sync()
  }
  sync()
  return button
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
        <a href="#/account" class="dropdown-item">${icon('user')}<span>个人资料</span></a>
        <a href="#/settings" class="dropdown-item">${icon('settings')}<span>设置</span></a>
        <button class="dropdown-item logout">${icon('log-out')}<span>退出登录</span></button>
      </div>
    </div>`)
  const btn = $('.avatar-btn', menu)
  const drop = $('.dropdown', menu)
  $('.user-avatar-slot', menu).replaceWith(avatarNode(site.user.name, site.user.avatarUrl, 'small'))
  $('.browser-notify-slot', menu).replaceWith(browserNotificationAction())
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
    await disablePush().catch(() => {})
    await api('/api/logout', { method: 'POST' })
    location.reload()
  }
  area.appendChild(menu)
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
  const settingsMatch = hash.match(/^#\/settings\/(site|ai|storage)$/)
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
      .catch(() => null)
  }
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
  if (site.user) autoEnablePush()
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
