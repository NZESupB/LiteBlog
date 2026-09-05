// 前端逻辑:hash 路由 + 时间轴 / 相册 / 登录 / 账号 / 设置视图
import { attachMdToolbar, attachEmojiButton } from '/vendor/md-toolbar.js'
import { icon } from '/vendor/icons.js'
import { api, streamSse, el, esc, setFormMessage, avatarColor, parseTime, formatTime, dateLabel } from '/js/utils.js'
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'notification-click') notificationTarget(event.data.postId, event.data.commentId)
  })
}

function closePostMenu() {
  if (!activePostMenu) return
  activePostMenu.menu.hidden = true
  activePostMenu.button.setAttribute('aria-expanded', 'false')
  activePostMenu = null
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
document.addEventListener('click', () => {
  document.querySelectorAll('.dropdown:not([hidden])').forEach((d) => (d.hidden = true))
})

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
  closePostMenu()
  revealObserver.disconnect()
  for (const observer of timelineObservers) observer.disconnect()
  timelineObservers = []
  main.innerHTML = ''
  main.className = 'container'
}

function emptyJournal(title, description, image = false) {
  const empty = el(`<div class="journal-empty">
    <span class="empty-symbol">${icon(image ? 'image' : 'heart')}</span>
    <h3>${esc(title)}</h3><p>${esc(description)}</p>
  </div>`)
  if (!site.user) empty.appendChild(el('<a class="btn" href="#/login">登录，写下第一篇</a>'))
  else if (image) empty.appendChild(el('<a class="btn-ghost" href="#/">去记录今天</a>'))
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

// ---------- 灯箱 ----------

const lightbox = $('#lightbox')
let lbUrls = []
let lbIndex = 0

function openLightbox(urls, index) {
  lbUrls = urls
  lbIndex = index
  $('#lightboxImg').src = lbUrls[lbIndex]
  lightbox.hidden = false
}
function lbMove(step) {
  lbIndex = (lbIndex + step + lbUrls.length) % lbUrls.length
  $('#lightboxImg').src = lbUrls[lbIndex]
}
$('.lb-close').onclick = () => (lightbox.hidden = true)
$('.lb-prev').onclick = () => lbMove(-1)
$('.lb-next').onclick = () => lbMove(1)
lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.hidden = true }
document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return
  if (e.key === 'Escape') lightbox.hidden = true
  if (e.key === 'ArrowLeft') lbMove(-1)
  if (e.key === 'ArrowRight') lbMove(1)
})

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
function createComposer(post, onDone, onCancel) {
  const card = el(`
    <div class="card compose">
      <div class="compose-heading"><span>${post ? '编辑这段日常' : '今天，有什么想记住的？'}</span>${icon('heart')}</div>
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
        <button class="md-polish" title="AI 优化正文" type="button">${icon('sparkles')}<span>AI 优化</span></button>
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
      <div class="preview-grid"></div>
      <div class="form-error"></div>
      <div class="compose-actions">
        <button class="btn-ghost pick" type="button" title="从相册选择" aria-label="从相册选择">${icon('image')}</button>
        <button class="btn-ghost camera" type="button" title="调用相机拍照" aria-label="调用相机拍照">${icon('camera')}</button>
        <div class="public-opts" ${site.privateMode ? '' : 'hidden'}>
          <span class="public-opts-tip">${icon('lock')}<span>访客可见</span></span>
          <label class="public-chip"><input type="checkbox" name="publicText" ${post && post.public_text ? 'checked' : ''} /><span>正文</span></label>
          <label class="public-chip"><input type="checkbox" name="publicImages" ${post && post.public_images ? 'checked' : ''} /><span>图片</span></label>
        </div>
        <span class="spacer"></span>
        ${post ? '<button class="btn-ghost cancel">取消</button>' : ''}
        <button class="btn submit">${post ? '保存' : '发布'}</button>
      </div>
      <input class="album-input" type="file" accept="image/*" multiple hidden />
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
    compare.hidden = true
    setPolishState(false)
  }

  async function runPolish() {
    const text = textarea.value.trim()
    if (!text) { errorLine.textContent = '先写点内容再优化'; return }
    errorLine.textContent = ''
    originPane.textContent = text
    resultPane.textContent = ''
    polishResult = ''
    compare.hidden = false
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
        compare.hidden = true
        location.hash = '#/settings'
        return
      }
      statusEl.textContent = ''
      errorLine.textContent = e.message
      if (!polishResult) { compare.hidden = true }
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

  textarea.value = post ? post.content : ''
  const keepImages = post ? post.images.map((img) => ({ ...img })) : [] // 保留的已有图片(已就绪,不显示处理动画)
  const newFiles = [] // 新增文件,含 _status: processing/uploading/done/error

  const STATUS_TEXT = { processing: '处理中', uploading: '上传中' }

  // 选完图立刻处理(HEIC 转码 + 压缩)并上传到存储后端,发布时只提交文件名
  async function processFile(file) {
    file._status = 'processing'
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
      const { filename } = await api('/api/uploads', { method: 'POST', body: form })
      file._name = filename
      file._status = 'done'
    } catch (e) {
      file._status = 'error'
      file._errMsg = e.message || '处理失败'
    }
    renderPreviews()
    updatePublishGuard()
  }

  function renderPreviews() {
    previews.innerHTML = ''
    const rows = [
      ...keepImages.map((img) => [keepImages, img]),
      ...newFiles.map((f) => [newFiles, f]),
    ]
    for (const [list, item] of rows) {
      const src = item._url || item.url || ''
      const node = el(`<div class="preview-item">${src ? `<img src="${src}" alt="" />` : ''}<button class="remove">×</button></div>`)
      if (item._status && item._status !== 'done') {
        const overlay = el(`<div class="upload-overlay${item._status === 'error' ? ' error' : ''}"></div>`)
        if (item._status === 'error') {
          overlay.textContent = item._errMsg || '失败'
        } else {
          overlay.appendChild(el('<span class="spinner"></span>'))
          overlay.appendChild(el(`<span>${STATUS_TEXT[item._status]}</span>`))
        }
        node.appendChild(overlay)
      } else if (item._status === 'done') {
        node.appendChild(el(`<div class="upload-badge">${icon('check')}</div>`))
      }
      $('.remove', node).onclick = () => {
        if (item._url && item._url.startsWith('blob:')) URL.revokeObjectURL(item._url)
        // 按对象定位而非渲染时的下标,避免删除过程中列表变动导致删错
        const idx = list.indexOf(item)
        if (idx >= 0) list.splice(idx, 1)
        renderPreviews()
        updatePublishGuard()
        // 新图已经传到存储后端了,撤掉时连带删除;已发布的老图仍由发布时的 keep 决定
        if (item._name) api(`/api/uploads/${item._name}`, { method: 'DELETE' }).catch(() => {})
      }
      previews.appendChild(node)
    }
  }

  // 发布守卫:任一图片还在处理或上传中则禁用发布
  function updatePublishGuard() {
    const pending = newFiles.some((f) => f._status === 'processing' || f._status === 'uploading')
    submitBtn.disabled = pending
    if (pending) submitBtn.textContent = '图片上传中…'
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
    newFiles.push(...picked)
    renderPreviews()
    updatePublishGuard()
    // 处理与上传异步进行,完成后各自刷新状态
    for (const f of picked) processFile(f)
  }
  fileInput.onchange = () => handleFiles(fileInput)
  cameraInput.onchange = () => handleFiles(cameraInput)

  submitBtn.onclick = async () => {
    const content = textarea.value.trim()
    const ready = newFiles.filter((f) => f._status === 'done')
    if (!content && keepImages.length + ready.length === 0) {
      errorLine.textContent = '写点什么或传张图吧'
      return
    }
    if (newFiles.some((f) => f._status === 'processing' || f._status === 'uploading')) return
    submitBtn.disabled = true
    submitBtn.textContent = '发布中…'
    errorLine.textContent = ''
    try {
      const payload = { content, images: ready.map((f) => f._name) }
      if (post) payload.keep = keepImages.map((img) => img.id)
      const pubText = $('[name=publicText]', card)
      const pubImages = $('[name=publicImages]', card)
      if (pubText) payload.publicText = pubText.checked
      if (pubImages) payload.publicImages = pubImages.checked
      await api(post ? `/api/posts/${post.id}` : '/api/posts', {
        method: post ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      onDone()
    } catch (e) {
      errorLine.textContent = e.message
      submitBtn.disabled = false
      updatePublishGuard()
    }
  }
  if (post) $('.cancel', card).onclick = onCancel
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
    bubble.hidden = false
    for (const t of ticks.values()) t.classList.toggle('hot', t === tick)
  }
  const endDrag = (commit) => {
    bubble.hidden = true
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
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    target.classList.remove('flash')
    void target.offsetWidth // 强制回流,同一目标可重复触发动画
    target.classList.add('flash')
  }

  function setReplyTarget(comment = null) {
    replyTarget = comment ? { id: comment.id, author: comment.author } : null
    if (!replyState || !input) return
    replyState.hidden = !replyTarget
    $('.comment-reply-target', replyState).textContent = replyTarget ? `回复 ${replyTarget.author}` : ''
    input.placeholder = replyTarget ? `回复 ${replyTarget.author}…` : '写条评论…'
  }

  function openComposer(comment = null) {
    if (!form || !input) return
    setReplyTarget(comment)
    wrap.hidden = false
    form.hidden = false
    input.focus()
  }

  async function load() {
    listEl.innerHTML = ''
    try {
      const { comments } = await api(`/api/posts/${p.id}/comments`)
      if (comments.length === 0) {
        if (!form || form.hidden) wrap.hidden = true
        return
      }
      wrap.hidden = false
      for (const c of comments) {
        const item = el(`
          <div class="comment">
            <span class="avatar tiny" style="background:${avatarColor(c.author)}">${esc(c.author[0])}</span>
            <div class="comment-body">
              <div class="comment-meta"><b>${esc(c.author)}</b> <span class="comment-time">${formatTime(c.created_at)}</span></div>
              <div class="comment-text"></div>
            </div>
            <div class="comment-actions"></div>
          </div>`)
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

function renderPost(p) {
  // 私密模式下未登录访客:按文章开关决定可见性,默认全隐
  const guest = site.privateMode && !site.user
  const showText = !guest || Boolean(p.public_text)
  const showImages = !guest || Boolean(p.public_images)

  const card = el(`
    <article class="card post">
      <div class="post-head">
        <div class="avatar" style="background:${avatarColor(p.author)}">${esc(p.author[0])}</div>
        <div class="post-meta">
          <div class="post-author">${esc(p.author)}</div>
          <div class="post-time">${formatTime(p.created_at)}${p.updated_at !== p.created_at ? ' · 已编辑' : ''}</div>
        </div>
        <div class="post-actions"><button class="more-btn" type="button" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${icon('ellipsis')}</button></div>
      </div>
      <div class="post-content"></div>
      <div class="img-grid n${p.images.length}" ${p.images.length ? '' : 'hidden'}></div>
    </article>`)

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
    contentEl.appendChild(el(`<div class="img-hidden-note">${icon('lock')}<span>该内容仅登录后可见</span></div>`))
  } else $('.post-content', card).remove()

  const grid = $('.img-grid', card)
  const urls = p.images.map((img) => img.url)
  p.images.forEach((img, i) => {
    const image = el(`<img src="${img.url}" alt="" loading="lazy" />`)
    image.onclick = () => openLightbox(urls, i)
    grid.appendChild(image)
  })

  const comments = renderComments(p)
  const reactions = renderReactions(p)
  card.append(reactions, comments)
  const menu = renderPostMenu(p, comments, reactions)
  const moreBtn = $('.more-btn', card)
  moreBtn.onclick = (e) => {
    e.stopPropagation()
    if (!menu.hidden) {
      closePostMenu()
      return
    }
    closePostMenu()
    activePostMenu = { menu, button: moreBtn }
    menu.hidden = false
    moreBtn.setAttribute('aria-expanded', 'true')
  }
  $('.post-actions', card).append(menu)
  menu.onclick = (e) => e.stopPropagation()

  // 编辑/删除入口由服务端下发的 canEdit 决定(以服务端时间为准,不受客户端时钟影响)
  if (p.canEdit) {
    const actions = $('.post-actions', card)
    const editBtn = el('<button>编辑</button>')
    const delBtn = el('<button>删除</button>')
    editBtn.onclick = () => {
      const composer = createComposer(p, renderTimeline, () => composer.replaceWith(renderPost(p)))
      card.replaceWith(composer)
      $('textarea', composer).focus()
    }
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
  const heading = el('<div class="journal-heading"><h2>日常手记</h2><span class="journal-count"></span></div>')
  main.appendChild(heading)
  if (site.user) main.appendChild(createComposer(null, renderTimeline))

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
  toTop.onclick = () => window.scrollTo({ top: 0 })
  main.appendChild(toTop)
  observeViewport(topSentinel, (visible) => (toTop.hidden = visible))

  if (month) window.scrollTo({ top: 0 })
}

// ---------- 单条动态视图(通知跳转的落地页) ----------

async function renderSinglePost(id) {
  clearMain()
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
  const heading = el('<div class="page-heading"><div><p>我们的日常</p><h1>影像集</h1></div><span class="gallery-count"></span></div>')
  $('p', heading).textContent = site.title
  main.appendChild(heading)
  try {
    const { images } = await api('/api/gallery')
    $('.gallery-count', heading).textContent = `${images.length} 张照片`
    if (images.length === 0) {
      main.appendChild(emptyJournal('等待第一张，一起的照片', '留住眼前的风景，也留住那一刻的心情。', true))
      return
    }
    const grid = el('<div class="gallery-grid"></div>')
    const urls = images.map((img) => img.url)
    images.forEach((img, i) => {
      const caption = `${img.author} · ${formatTime(img.created_at)}`
      const photo = el(`<button class="gallery-photo" type="button" aria-label="查看照片：${esc(caption)}">
        <img src="${esc(img.url)}" alt="${esc(caption)}" loading="lazy" />
        <span>${esc(caption)}</span>
      </button>`)
      photo.onclick = () => openLightbox(urls, i)
      grid.appendChild(photo)
    })
    main.appendChild(grid)
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
      <h2>欢迎回家</h2>
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
      const loginResult = await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('[name=username]', form).value.trim(), password: $('[name=password]', form).value }),
      })
      // 登录成功后再请求权限,避免错误账号也触发浏览器授权弹窗。
      const permission = await requestPushPermissionFromGesture()
      if (permission !== 'unsupported') {
        try { sessionStorage.setItem(pushAttemptKey(loginResult.user?.id), '1') } catch {}
      }
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

// ---------- 账号视图(修改登录账号、显示名称与密码) ----------

function renderAccount() {
  if (!site.user) return renderLogin()
  clearMain()
  const currentUsername = site.user.username || site.user.name
  const currentDisplayName = site.user.displayName || site.user.name
  const page = el(`
    <div class="account-page">
      <header class="account-page-header">
        <a class="account-back" href="#/" aria-label="返回时间轴" title="返回时间轴">${icon('arrow-left')}</a>
        <h1 tabindex="-1">账号设置</h1>
      </header>

      <form class="account-section profile-form">
        <h2>账户信息</h2>
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

function renderSettings() {
  if (!site.user) return renderLogin()
  clearMain()
  const card = el(`
    <div class="card settings-card">
      <h2>站点设置</h2>
      <label>站点名称<input name="title" value="${esc(site.title)}" /></label>
      <label>起始日期(顶栏显示「第 N 天」)<input name="anniversary" type="date" value="${esc(site.anniversary)}" /></label>
      <label class="row">
        <input name="privateMode" type="checkbox" ${site.privateMode ? 'checked' : ''} />
        <span>私密模式(未登录访客仅可看文字,图片与相册不可见)</span>
      </label>
      <div class="form-error"></div>
      <div class="settings-actions">
        <span class="save-tip" hidden>已保存</span>
        <button class="btn save">保存</button>
      </div>
    </div>`)
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
  main.appendChild(card)
  renderStorageCard()
  renderLlmCard()
}

// AI 优化配置(兼容 OpenAI Chat Completions 接口):共享 API 可各自选模型,也可使用独立 API。
async function renderLlmCard() {
  let s
  try {
    s = await api('/api/llm')
  } catch (e) {
    main.appendChild(el(`<div class="empty-tip">${esc(e.message)}</div>`))
    return
  }
  const custom = s.mode === 'custom'
  const card = el(`
    <div class="card settings-card">
      <h2>AI 优化</h2>
      <div class="storage-status">在发布框点「AI 优化」即可调用,凭据只存本服务器</div>
      <label class="row">
        <input name="mode" type="radio" value="shared" ${custom ? '' : 'checked'} />
        <span>使用已配置的共享 API</span>
      </label>
      <label class="row">
        <input name="mode" type="radio" value="custom" ${custom ? 'checked' : ''} />
        <span>配置独立 API</span>
      </label>
      <div class="llm-shared" ${custom ? 'hidden' : ''}>
        <div class="llm-global-hint">${s.shared.baseUrl ? `共享接口:${esc(s.shared.baseUrl)} · 默认模型:${esc(s.shared.model || '未设模型')}` : '尚未配置共享接口,可由任一账号首次填写'}</div>
        <label>共享接口地址(OpenAI 兼容)<input name="sharedBaseUrl" value="${esc(s.shared.baseUrl)}" placeholder="https://api.openai.com/v1" /></label>
        <label>共享 API Key<input name="sharedApiKey" type="password" placeholder="${s.shared.hasApiKey ? '已保存,留空表示不修改' : 'sk-…'}" /></label>
        <label>本次使用模型
          <span class="llm-model-row">
            <input name="sharedModel" list="llm-model-list" value="${esc(s.sharedModel)}" placeholder="gpt-4o-mini" />
            <button type="button" class="btn-ghost fetch-models">自动获取</button>
          </span>
          <select class="llm-model-picker" name="sharedModelPicker" aria-label="选择共享模型" hidden></select>
        </label>
      </div>
      <div class="llm-custom" ${custom ? '' : 'hidden'}>
        <label>接口地址(OpenAI 兼容)<input name="baseUrl" value="${esc(s.custom.baseUrl)}" placeholder="https://api.openai.com/v1" /></label>
        <label>模型
          <span class="llm-model-row">
            <input name="customModel" list="llm-model-list" value="${esc(s.custom.model)}" placeholder="gpt-4o-mini" />
            <button type="button" class="btn-ghost fetch-models">自动获取</button>
          </span>
          <select class="llm-model-picker" name="customModelPicker" aria-label="选择独立模型" hidden></select>
        </label>
        <label>API Key<input name="apiKey" type="password" placeholder="${s.custom.hasApiKey ? '已保存,留空表示不修改' : 'sk-…'}" /></label>
      </div>
      <datalist id="llm-model-list"></datalist>
      <div class="settings-actions">
        <span class="save-tip" hidden>已保存</span>
        <span class="spacer"></span>
        <button class="btn-ghost test">测试连接</button>
        <button class="btn save">保存</button>
      </div>
      <div class="form-error"></div>
    </div>`)
  const err = $('.form-error', card)
  const modeBoxes = card.querySelectorAll('[name=mode]')
  const sharedWrap = $('.llm-shared', card)
  const customWrap = $('.llm-custom', card)
  const selectedMode = () => $('[name=mode]:checked', card).value
  const modelInput = (mode = selectedMode()) => $(`[name=${mode === 'shared' ? 'sharedModel' : 'customModel'}]`, card)
  const modelPicker = (mode = selectedMode()) => $(`[name=${mode === 'shared' ? 'sharedModelPicker' : 'customModelPicker'}]`, card)
  const updateMode = () => {
    const shared = selectedMode() === 'shared'
    sharedWrap.hidden = !shared
    customWrap.hidden = shared
  }
  for (const modeBox of modeBoxes) modeBox.onchange = updateMode
  for (const picker of card.querySelectorAll('.llm-model-picker')) picker.onchange = () => {
    if (picker.value) modelInput(picker.name === 'sharedModelPicker' ? 'shared' : 'custom').value = picker.value
  }

  const currentPayload = () => {
    const mode = selectedMode()
    return mode === 'shared'
      ? {
          mode,
          sharedBaseUrl: $('[name=sharedBaseUrl]', card).value,
          sharedApiKey: $('[name=sharedApiKey]', card).value,
          model: $('[name=sharedModel]', card).value,
        }
      : {
          mode,
          baseUrl: $('[name=baseUrl]', card).value,
          apiKey: $('[name=apiKey]', card).value,
          model: $('[name=customModel]', card).value,
        }
  }

  for (const fetchButton of card.querySelectorAll('.fetch-models')) fetchButton.onclick = async () => {
    err.textContent = ''
    err.style.color = ''
    const btn = fetchButton
    btn.disabled = true
    btn.textContent = '获取中…'
    try {
      const mode = selectedMode()
      const r = await api('/api/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentPayload()),
      })
      const list = $('#llm-model-list', card)
      list.innerHTML = ''
      for (const m of r.models) list.appendChild(el(`<option value="${esc(m)}"></option>`))
      const input = modelInput(mode)
      const picker = modelPicker(mode)
      const models = [...new Set(r.models.filter((m) => typeof m === 'string' && m.trim()))]
      const options = input.value && !models.includes(input.value) ? [input.value, ...models] : models
      picker.innerHTML = options.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      picker.value = input.value
      picker.hidden = options.length === 0
      err.textContent = r.models.length ? `已获取 ${r.models.length} 个模型` : '接口未返回模型列表'
      err.style.color = '#2a9d4a'
    } catch (e) {
      err.textContent = e.message
    } finally {
      btn.disabled = false
      btn.textContent = '自动获取'
    }
  }

  $('.save', card).onclick = async () => {
    err.textContent = ''
    err.style.color = ''
    try {
      await api('/api/llm', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentPayload()) })
      $('.save-tip', card).hidden = false
      setTimeout(renderSettings, 600)
    } catch (e) {
      err.textContent = e.message
    }
  }
  $('.test', card).onclick = async () => {
    err.textContent = ''
    err.style.color = ''
    try {
      await api('/api/llm/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentPayload()) })
      err.textContent = '连接成功'
      err.style.color = '#2a9d4a'
    } catch (e) {
      err.textContent = e.message
    }
  }
  main.appendChild(card)
}

// 图片存储配置(本地磁盘 / WebDAV)
async function renderStorageCard() {
  let s
  try {
    s = await api('/api/storage')
  } catch (e) {
    main.appendChild(el(`<div class="empty-tip">${esc(e.message)}</div>`))
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
  main.appendChild(card)
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
  const registration = await readyServiceWorker()
  if (!registration?.pushManager) throw new Error('通知服务尚未就绪')
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') return false
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

function requestPushPermissionFromGesture() {
  if (!window.isSecureContext ||
      !('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator) ||
      Notification.permission !== 'default') return Promise.resolve('unsupported')
  return Notification.requestPermission().catch(() => 'default')
}

function pushAttemptKey(userId) {
  return `push-auto-attempted:${userId || 'anonymous'}`
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
    if (Notification.permission === 'default') {
      let attempted = false
      try { attempted = sessionStorage.getItem(pushAttemptKey(site.user.id)) === '1' } catch {}
      if (attempted) return
      try { sessionStorage.setItem(pushAttemptKey(site.user.id), '1') } catch {}
    }
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

function browserNotificationAction() {
  // 先给出常见态的文案,等 sync() 拿到真实订阅状态再校正;Service Worker 迟迟不激活时也不会是个空白项
  const button = el(`<button class="dropdown-item browser-notify" type="button" disabled>${icon('bell')}<span>开启浏览器通知</span></button>`)
  const label = $('span', button)
  // pushManager 只在安全上下文里存在,http 部署时直接告知原因,别让用户点了没反应
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    label.textContent = window.isSecureContext ? '浏览器不支持通知' : '通知需要 HTTPS'
    return button
  }
  if (Notification.permission === 'denied') {
    label.textContent = '通知权限已被阻止'
    return button
  }

  const sync = async () => {
    try {
      label.textContent = (await currentPushSubscription()) ? '关闭浏览器通知' : '开启浏览器通知'
    } catch {
      label.textContent = '通知暂时不可用'
    } finally {
      button.disabled = false
    }
  }
  button.onclick = async () => {
    button.disabled = true
    label.textContent = '处理中…'
    try {
      if (await currentPushSubscription()) await disablePush()
      else if (!await enablePush()) alert('未获得通知权限')
    } catch (e) {
      alert(e.message || '无法开启浏览器通知')
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
        drop.hidden = true
        notificationTarget(it.post_id, it.id)
      }
      drop.appendChild(node)
    }
  }

  btn.onclick = async (e) => {
    e.stopPropagation()
    const open = drop.hidden
    if (open) {
      const refreshed = await refresh()
      renderList()
      // 打开即视为已读:清角标并推进服务端水位线,列表本次仍保留供点击
      if (refreshed && !badge.hidden) {
        badge.hidden = true
        api('/api/notifications/read', { method: 'POST' }).catch(() => {})
      }
    }
    drop.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
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
    area.appendChild(el('<a href="#/login">登录</a>'))
    return
  }
  area.appendChild(renderNotifyBell())
  // 头像 + 下拉菜单:设置 / 退出
  const menu = el(`
    <div class="user-menu">
      <button class="avatar-btn" aria-haspopup="true" aria-expanded="false">
        <span class="avatar small" style="background:${avatarColor(site.user.name)}">${esc(site.user.name[0])}</span>
      </button>
      <div class="dropdown" hidden>
        <div class="dropdown-name">${esc(site.user.name)}</div>
        <div class="browser-notify-slot"></div>
        <a href="#/account" class="dropdown-item">${icon('user')}<span>账号设置</span></a>
        <a href="#/settings" class="dropdown-item">${icon('settings')}<span>站点设置</span></a>
        <button class="dropdown-item logout">${icon('log-out')}<span>退出登录</span></button>
      </div>
    </div>`)
  const btn = $('.avatar-btn', menu)
  const drop = $('.dropdown', menu)
  $('.browser-notify-slot', menu).replaceWith(browserNotificationAction())
  btn.onclick = (e) => {
    e.stopPropagation()
    const open = drop.hidden
    drop.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
  }
  menu.querySelectorAll('.dropdown-item[href]').forEach((a) => (a.onclick = () => (drop.hidden = true)))
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
    a.classList.toggle('active', a.getAttribute('href') === hash)
  })
  if (hash === '#/login') return site.user ? (location.hash = '#/') : renderLogin()
  if (hash === '#/account') return renderAccount()
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

async function init() {
  site = await api('/api/site')
  document.title = site.title
  $('meta[name="apple-mobile-web-app-title"]').content = site.title
  $('.site-name').textContent = site.title
  $('.site-heart').innerHTML = icon('heart')
  trackHeaderHeight()
  if (site.anniversary) {
    const days = Math.floor((Date.now() - new Date(site.anniversary + 'T00:00:00')) / 86400000) + 1
    if (days > 0) {
      const el2 = $('#days')
      el2.innerHTML = `<span>第 ${days} 天</span>`
      el2.hidden = false
    }
  }
  if ('serviceWorker' in navigator) {
    // 推送订阅要求 registration 已激活,统一等到 ready 再交给通知开关使用
    serviceWorkerRegistration = navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .catch(() => null)
  }
  renderUserArea()
  route()
  if (site.user) autoEnablePush()
}

window.addEventListener('hashchange', route)
init()
