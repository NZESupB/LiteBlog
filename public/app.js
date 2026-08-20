// 前端逻辑:hash 路由 + 时间轴 / 相册 / 登录 / 账号 / 设置视图
import { attachMdToolbar, attachEmojiButton } from '/vendor/md-toolbar.js'
import { icon } from '/vendor/icons.js'
const $ = (sel, el = document) => el.querySelector(sel)
const main = $('#main')

let site = null // { title, anniversary, privateMode, user }
const PAGE_SIZE = 20
const AVATAR_COLORS = ['#e8747c', '#7ca9e8', '#8ec9a0', '#c99be0', '#e8b06e']
const REACTION_EMOJIS = '👍 ❤️ 😂 😍 🎉 😢 😡 👏 🔥 💯 🙌 🥰 😮 🤔'.split(' ')
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000
let activePostMenu = null
let serviceWorkerRegistration = null

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

// ---------- 基础工具 ----------

async function api(path, opts = {}) {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `请求失败 (${res.status})`)
  return data
}

// SSE 流式请求:服务端协议为 data:{"delta"} / data:{"error"} / data:[DONE]
// 上游失败时服务端仍回普通 JSON 错误,所以这里按 res.ok 分流,错误语义与 api() 一致
async function streamSse(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || data.message || `请求失败 (${res.status})`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // 事件以空行分隔,末段可能不完整,留在缓冲里等下一个分片
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let evt = null
        try { evt = JSON.parse(payload) } catch { continue }
        if (evt.error) throw new Error(evt.error)
        onEvent(evt)
      }
    }
  }
}

function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function setFormMessage(element, message, state = 'error') {
  element.textContent = message
  element.dataset.state = message ? state : ''
}

function avatarColor(name) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

// SQLite 存的是 UTC,转本地时间展示
function parseTime(s) {
  return new Date(s.replace(' ', 'T') + 'Z')
}

function withinEditWindow(createdAt) {
  const time = parseTime(createdAt).getTime()
  return Number.isFinite(time) && Date.now() - time <= EDIT_WINDOW_MS
}

function formatTime(s) {
  const d = parseTime(s)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = (a, b) => a.toDateString() === b.toDateString()
  if (sameDay(d, now)) return `今天 ${hm}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `昨天 ${hm}`
  const y = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

function dateLabel(s) {
  const d = parseTime(s)
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 周${week}`
}

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

// 切换视图即清空主区域;未进过视口的观察目标随之作废,避免观察表越积越长
function clearMain() {
  closePostMenu()
  revealObserver.disconnect()
  main.innerHTML = ''
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
        <textarea placeholder="记录一下今天的小事…"></textarea>
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
  for (const emoji of REACTION_EMOJIS) {
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
        <div class="post-actions"><button class="more-btn" type="button" title="更多操作" aria-haspopup="menu" aria-expanded="false">更多</button></div>
      </div>
      <div class="post-content"></div>
      <div class="img-grid n${p.images.length}" ${p.images.length ? '' : 'hidden'}></div>
    </article>`)

  if (p.content && showText) {
    const contentEl = $('.post-content', card)
    contentEl.innerHTML = marked.parse(p.content)
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

  if (site.user && site.user.id === p.user_id && Date.now() - parseTime(p.created_at).getTime() <= 24 * 60 * 60 * 1000) {
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

async function renderTimeline() {
  clearMain()
  if (site.user) main.appendChild(createComposer(null, renderTimeline))

  const list = el('<div class="post-list"></div>')
  main.appendChild(list)
  let offset = 0
  let lastDate = ''

  async function loadMore(btn) {
    const { posts, total } = await api(`/api/posts?limit=${PAGE_SIZE}&offset=${offset}`)
    offset += posts.length
    for (const p of posts) {
      const label = dateLabel(p.created_at)
      if (label !== lastDate) {
        lastDate = label
        list.appendChild(reveal(el(`<div class="date-divider">${label}</div>`)))
      }
      list.appendChild(reveal(renderPost(p)))
    }
    if (btn) btn.remove()
    if (offset < total) {
      const more = el('<button class="btn-ghost load-more">加载更多</button>')
      more.onclick = () => loadMore(more)
      main.appendChild(more)
    }
    if (total === 0) list.appendChild(el('<div class="empty-tip">还没有动态,写下第一条吧</div>'))
  }
  await loadMore(null).catch((e) => list.appendChild(el(`<div class="empty-tip">${esc(e.message)}</div>`)))
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
  try {
    const { images } = await api('/api/gallery')
    if (images.length === 0) {
      main.appendChild(el('<div class="empty-tip">相册还是空的,发条带图的动态吧</div>'))
      return
    }
    const grid = el('<div class="gallery-grid"></div>')
    const urls = images.map((img) => img.url)
    images.forEach((img, i) => {
      const image = el(`<img src="${img.url}" alt="" loading="lazy" title="${esc(img.author)} · ${formatTime(img.created_at)}" />`)
      image.onclick = () => openLightbox(urls, i)
      grid.appendChild(image)
    })
    main.appendChild(grid)
  } catch (e) {
    main.appendChild(el(`<div class="empty-tip">${esc(e.message)}</div>`))
  }
}

// ---------- 登录视图 ----------

function renderLogin() {
  clearMain()
  const form = el(`
    <form class="card login-card">
      <h2>${esc(site.title)}</h2>
      <div class="sub">${site.privateMode ? '登录后可查看图片、相册与发布动态' : '登录后可以发布动态'}</div>
      <input name="username" placeholder="登录账号" autocomplete="username" autocapitalize="none" spellcheck="false" />
      <input name="password" type="password" placeholder="密码" autocomplete="current-password" />
      <div class="form-error"></div>
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
let browserNotificationBaseline = null

function browserNotificationKey() {
  return site?.user ? `browser-notifications:${site.user.id}` : ''
}

function readBrowserNotificationId() {
  try { return Number(localStorage.getItem(`${browserNotificationKey()}:last-id`)) || 0 } catch { return 0 }
}

function writeBrowserNotificationId(id) {
  try { localStorage.setItem(`${browserNotificationKey()}:last-id`, String(id)) } catch {}
}

function browserNotificationsEnabled() {
  try { return localStorage.getItem(browserNotificationKey()) === 'enabled' } catch { return false }
}

function notificationTarget(postId, commentId) {
  pendingCommentFocus = { postId, commentId }
  const target = `#/post/${postId}?comment=${commentId}`
  if (location.hash === target) route()
  else location.hash = target
  window.focus?.()
}

async function showBrowserNotification(item) {
  if (document.visibilityState !== 'hidden' || !browserNotificationsEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return true
  const excerpt = item.content.length > 80 ? item.content.slice(0, 80) + '…' : item.content
  const options = {
    body: `${item.reply_to_me ? '回复了你' : '评论了'}: ${excerpt}`,
    tag: `comment-${item.id}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { postId: item.post_id, commentId: item.id },
  }
  try {
    const registration = await serviceWorkerRegistration
    if (registration?.showNotification) {
      try {
        await registration.showNotification(`${item.author} · ${site.title}`, options)
        return true
      } catch {}
    }
    const notice = new Notification(`${item.author} · ${site.title}`, options)
    notice.onclick = () => notificationTarget(item.post_id, item.id)
    return true
  } catch {
    return false
  }
}

async function toggleBrowserNotifications(button) {
  if (!('Notification' in window)) return
  if (browserNotificationsEnabled() && Notification.permission === 'granted') {
    try { localStorage.removeItem(browserNotificationKey()) } catch {}
    button.querySelector('span').textContent = '开启浏览器通知'
    return
  }
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    alert('浏览器通知需要 HTTPS 环境')
    return
  }
  try {
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (permission !== 'granted') {
      button.querySelector('span').textContent = permission === 'denied' ? '通知权限已被阻止' : '开启浏览器通知'
      button.disabled = permission === 'denied'
      return
    }
    localStorage.setItem(browserNotificationKey(), 'enabled')
    button.querySelector('span').textContent = '关闭浏览器通知'
  } catch {
    alert('无法开启浏览器通知')
  }
}

function browserNotificationAction() {
  const supported = 'Notification' in window
  const enabled = supported && Notification.permission === 'granted' && browserNotificationsEnabled()
  const blocked = supported && Notification.permission === 'denied'
  const label = !supported ? '浏览器不支持通知' : blocked ? '通知权限已被阻止' : enabled ? '关闭浏览器通知' : '开启浏览器通知'
  const button = el(`<button class="dropdown-item browser-notify" type="button"${!supported || blocked ? ' disabled' : ''}>${icon('bell')}<span>${label}</span></button>`)
  if (supported && !blocked) button.onclick = () => toggleBrowserNotifications(button)
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
      const nextItems = (await api('/api/notifications')).items
      const maxId = nextItems.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0)
      if (browserNotificationBaseline === null) {
        browserNotificationBaseline = Math.max(maxId, readBrowserNotificationId())
        writeBrowserNotificationId(browserNotificationBaseline)
      } else {
        const storedId = readBrowserNotificationId()
        const currentBaseline = Math.max(browserNotificationBaseline, storedId)
        const freshItems = nextItems
          .filter((item) => Number(item.id) > currentBaseline)
          .sort((a, b) => Number(a.id) - Number(b.id))
        let handledId = currentBaseline
        for (const item of freshItems) {
          if (!await showBrowserNotification(item)) break
          handledId = Number(item.id)
        }
        browserNotificationBaseline = handledId
        writeBrowserNotificationId(browserNotificationBaseline)
      }
      items = nextItems
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
  document.addEventListener('click', () => (drop.hidden = true))
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
  document.addEventListener('click', () => (drop.hidden = true))
  menu.querySelectorAll('.dropdown-item[href]').forEach((a) => (a.onclick = () => (drop.hidden = true)))
  $('.logout', menu).onclick = async () => {
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

async function init() {
  site = await api('/api/site')
  document.title = site.title
  $('.site-title').textContent = site.title
  if (site.anniversary) {
    const days = Math.floor((Date.now() - new Date(site.anniversary + 'T00:00:00')) / 86400000) + 1
    if (days > 0) {
      const el2 = $('#days')
      el2.innerHTML = `${icon('heart')}<span>第 ${days} 天</span>`
      el2.hidden = false
    }
  }
  if ('serviceWorker' in navigator) {
    serviceWorkerRegistration = navigator.serviceWorker.register('/sw.js').catch(() => null)
  }
  renderUserArea()
  route()
}

window.addEventListener('hashchange', route)
init()
