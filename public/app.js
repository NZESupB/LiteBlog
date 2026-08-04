// 前端逻辑:hash 路由 + 时间轴 / 相册 / 登录 / 账号 / 设置视图
import { attachMdToolbar } from '/vendor/md-toolbar.js'
const $ = (sel, el = document) => el.querySelector(sel)
const main = $('#main')

let site = null // { title, anniversary, privateMode, user }
const PAGE_SIZE = 20
const AVATAR_COLORS = ['#e8747c', '#7ca9e8', '#8ec9a0', '#c99be0', '#e8b06e']

// ---------- 基础工具 ----------

async function api(path, opts = {}) {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`)
  return data
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
// post 传 null 表示新建;编辑时带已有图片(keep 未勾除的 id)
function createComposer(post, onDone, onCancel) {
  const card = el(`
    <div class="card compose">
      <div class="md-toolbar" role="toolbar" aria-label="Markdown 格式">
        <button data-md="bold" title="加粗 (⌘B)"><b>B</b></button>
        <button data-md="italic" title="斜体 (⌘I)"><i>I</i></button>
        <button data-md="strikethrough" title="删除线"><s>S</s></button>
        <span class="md-sep"></span>
        <button data-md="heading" title="标题">H</button>
        <button data-md="quote" title="引用">❝</button>
        <button data-md="code-inline" title="行内代码">&lt;/&gt;</button>
        <button data-md="code-block" title="代码块">{ }</button>
        <span class="md-sep"></span>
        <button data-md="list-ul" title="无序列表">•—</button>
        <button data-md="list-ol" title="有序列表">1—</button>
        <button data-md="tasklist" title="任务列表">☑</button>
        <button data-md="link" title="链接 (⌘K)">🔗</button>
        <span class="md-sep"></span>
        <button data-md="emoji" title="表情" type="button">😊</button>
        <button class="md-polish" title="AI 润色正文" type="button">✨ 润色</button>
      </div>
      <textarea placeholder="记录一下今天的小事…(支持 Markdown)"></textarea>
      <div class="preview-grid"></div>
      <div class="public-opts" ${site.privateMode ? '' : 'hidden'}>
        <span class="public-opts-tip">私密模式下对未登录访客公开:</span>
        <label class="row"><input type="checkbox" name="publicText" ${post && post.public_text ? 'checked' : ''} /><span>正文</span></label>
        <label class="row"><input type="checkbox" name="publicImages" ${post && post.public_images ? 'checked' : ''} /><span>图片</span></label>
      </div>
      <div class="form-error"></div>
      <div class="compose-actions">
        <button class="btn-ghost pick" title="从相册选择">📷 相册</button>
        <button class="btn-ghost camera" title="调用相机拍照">📸 拍照</button>
        <span class="spacer"></span>
        ${post ? '<button class="btn-ghost cancel">取消</button>' : ''}
        <button class="btn submit">${post ? '保存' : '发布'}</button>
      </div>
      <input class="album-input" type="file" accept="image/*" multiple hidden />
      <input class="camera-input" type="file" accept="image/*" capture="environment" hidden />
    </div>`)
  const textarea = $('textarea', card)
  attachMdToolbar($('.md-toolbar', card), textarea)
  const previews = $('.preview-grid', card)
  const fileInput = $('.album-input', card)
  const cameraInput = $('.camera-input', card)
  const errorLine = $('.form-error', card)
  const submitBtn = $('.submit', card)
  const polishBtn = $('.md-polish', card)

  // AI 润色:调用后端代理(凭据服务端保管),返回润色后的正文替换全文
  if (polishBtn) {
    polishBtn.onclick = async () => {
      const text = textarea.value.trim()
      if (!text) { errorLine.textContent = '先写点内容再润色'; return }
      const original = polishBtn.textContent
      polishBtn.disabled = true
      polishBtn.textContent = '润色中…'
      errorLine.textContent = ''
      try {
        const r = await api('/api/llm/polish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (r.text && r.text.trim()) {
          textarea.value = r.text.trim()
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          errorLine.textContent = 'AI 未返回有效结果'
        }
      } catch (e) {
        errorLine.textContent = e.message
      } finally {
        polishBtn.disabled = false
        polishBtn.textContent = original
      }
    }
  }

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
        node.appendChild(el('<div class="upload-badge">✓</div>'))
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

// 评论区块:列表 + (登录用户)输入框。可删除自己评论或自己动态下的评论
function renderComments(p) {
  const wrap = el(`<div class="comments"><div class="comments-list"></div><div class="comment-form"></div></div>`)
  const listEl = $('.comments-list', wrap)

  async function load() {
    listEl.innerHTML = ''
    try {
      const { comments } = await api(`/api/posts/${p.id}/comments`)
      if (comments.length === 0) return
      for (const c of comments) {
        const item = el(`
          <div class="comment">
            <span class="avatar tiny" style="background:${avatarColor(c.author)}">${esc(c.author[0])}</span>
            <div class="comment-body">
              <div class="comment-meta"><b>${esc(c.author)}</b> <span class="comment-time">${formatTime(c.created_at)}</span></div>
              <div class="comment-text"></div>
            </div>
            <div class="comment-del"></div>
          </div>`)
        $('.comment-text', item).textContent = c.content
        if (site.user && (c.user_id === site.user.id || p.user_id === site.user.id)) {
          const btn = el('<button class="link-btn" title="删除评论">删除</button>')
          btn.onclick = async () => {
            if (!confirm('删除这条评论?')) return
            await api(`/api/posts/${p.id}/comments/${c.id}`, { method: 'DELETE' }).catch((e) => alert(e.message))
            load()
          }
          $('.comment-del', item).appendChild(btn)
        }
        listEl.appendChild(item)
      }
    } catch { /* 私密模式未登录等,静默 */ }
  }
  load()

  if (site.user) {
    const form = $('.comment-form', wrap)
    const input = el('<input class="comment-input" placeholder="写条评论…" maxlength="500" />')
    const btn = el('<button class="btn tiny">评论</button>')
    const post_comment = async () => {
      const content = input.value.trim()
      if (!content) return
      btn.disabled = true
      try {
        await api(`/api/posts/${p.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        })
        input.value = ''
        load()
      } catch (e) {
        alert(e.message)
      } finally {
        btn.disabled = false
      }
    }
    btn.onclick = post_comment
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post_comment() } }
    form.append(input, btn)
  }
  return wrap
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
        <div class="post-actions"></div>
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
    contentEl.appendChild(el('<div class="img-hidden-note">🔒 该内容仅登录后可见</div>'))
  } else $('.post-content', card).remove()

  const grid = $('.img-grid', card)
  const urls = p.images.map((img) => img.url)
  p.images.forEach((img, i) => {
    const image = el(`<img src="${img.url}" alt="" loading="lazy" />`)
    image.onclick = () => openLightbox(urls, i)
    grid.appendChild(image)
  })

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

  // 评论:登录用户可见列表与输入框;动态卡片下方
  card.appendChild(renderComments(p))
  return card
}

async function renderTimeline() {
  main.innerHTML = ''
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
        list.appendChild(el(`<div class="date-divider">${label}</div>`))
      }
      list.appendChild(renderPost(p))
    }
    if (btn) btn.remove()
    if (offset < total) {
      const more = el('<button class="btn-ghost load-more">加载更多</button>')
      more.onclick = () => loadMore(more)
      main.appendChild(more)
    }
    if (total === 0) list.appendChild(el('<div class="empty-tip">还没有动态,写下第一条吧 💕</div>'))
  }
  await loadMore(null).catch((e) => list.appendChild(el(`<div class="empty-tip">${esc(e.message)}</div>`)))
}

// ---------- 相册视图 ----------

async function renderGallery() {
  main.innerHTML = ''
  try {
    const { images } = await api('/api/gallery')
    if (images.length === 0) {
      main.appendChild(el('<div class="empty-tip">相册还是空的,发条带图的动态吧 📷</div>'))
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
  main.innerHTML = ''
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
  main.innerHTML = ''
  const currentUsername = site.user.username || site.user.name
  const currentDisplayName = site.user.displayName || site.user.name
  const page = el(`
    <div class="account-page">
      <header class="account-page-header">
        <a class="account-back" href="#/" aria-label="返回时间轴" title="返回时间轴">←</a>
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
  main.innerHTML = ''
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
        <span class="save-tip" hidden>已保存 ✓</span>
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

// AI 润色配置(兼容 OpenAI Chat Completions 接口):全局默认 + 用户自定义
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
      <h2>AI 润色</h2>
      <div class="storage-status">在发布框点「✨ 润色」即可调用,凭据只存本服务器</div>
      <label class="row">
        <input name="mode" type="checkbox" ${custom ? 'checked' : ''} />
        <span>使用自定义配置(不勾选则用上方默认配置)</span>
      </label>
      <div class="llm-global-hint">${s.global.baseUrl ? `默认配置:${esc(s.global.baseUrl)} · ${esc(s.global.model || '未设模型')}` : '尚未配置默认接口'}</div>
      <div class="llm-custom" ${custom ? '' : 'hidden'}>
        <label>接口地址(OpenAI 兼容)<input name="baseUrl" value="${esc(s.custom.baseUrl)}" placeholder="https://api.openai.com/v1" /></label>
        <label>模型
          <span class="llm-model-row">
            <input name="model" list="llm-model-list" value="${esc(s.custom.model)}" placeholder="gpt-4o-mini" />
            <datalist id="llm-model-list"></datalist>
            <button type="button" class="btn-ghost fetch-models">自动获取</button>
          </span>
        </label>
        <label>API Key<input name="apiKey" type="password" placeholder="${s.custom.hasApiKey ? '已保存,留空表示不修改' : 'sk-…'}" /></label>
      </div>
      <div class="settings-actions">
        <span class="save-tip" hidden>已保存 ✓</span>
        <span class="spacer"></span>
        <button class="btn-ghost test">测试连接</button>
        <button class="btn save">保存</button>
      </div>
      <div class="form-error"></div>
    </div>`)
  const err = $('.form-error', card)
  const modeBox = $('[name=mode]', card)
  const customWrap = $('.llm-custom', card)
  modeBox.onchange = () => { customWrap.hidden = !modeBox.checked }

  const currentPayload = () => ({
    mode: modeBox.checked ? 'custom' : 'default',
    baseUrl: $('[name=baseUrl]', card).value,
    model: $('[name=model]', card).value,
    apiKey: $('[name=apiKey]', card).value,
  })

  $('.fetch-models', card).onclick = async () => {
    err.textContent = ''
    err.style.color = ''
    const btn = $('.fetch-models', card)
    btn.disabled = true
    btn.textContent = '获取中…'
    try {
      const r = await api('/api/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: $('[name=baseUrl]', card).value, apiKey: $('[name=apiKey]', card).value }),
      })
      const list = $('#llm-model-list', card)
      list.innerHTML = ''
      for (const m of r.models) list.appendChild(el(`<option value="${esc(m)}"></option>`))
      err.textContent = r.models.length ? `已获取 ${r.models.length} 个模型,在模型输入框下拉选择` : '接口未返回模型列表'
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
      err.textContent = '连接成功 ✅'
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
        <span class="save-tip" hidden>已保存 ✓</span>
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
      storageErr.textContent = '连接成功 ✅'
      storageErr.style.color = '#2a9d4a'
    } catch (e) {
      storageErr.textContent = e.message
      storageErr.style.color = '#c33'
    }
  }
  main.appendChild(card)
}

// ---------- 顶栏与路由 ----------

function renderUserArea() {
  const area = $('#userArea')
  area.innerHTML = ''
  if (!site.user) {
    area.appendChild(el('<a href="#/login">登录</a>'))
    return
  }
  // 头像 + 下拉菜单:设置 / 退出
  const menu = el(`
    <div class="user-menu">
      <button class="avatar-btn" aria-haspopup="true" aria-expanded="false">
        <span class="avatar small" style="background:${avatarColor(site.user.name)}">${esc(site.user.name[0])}</span>
      </button>
      <div class="dropdown" hidden>
        <div class="dropdown-name">${esc(site.user.name)}</div>
        <a href="#/account" class="dropdown-item">👤 账号设置</a>
        <a href="#/settings" class="dropdown-item">⚙️ 站点设置</a>
        <button class="dropdown-item logout">🚪 退出登录</button>
      </div>
    </div>`)
  const btn = $('.avatar-btn', menu)
  const drop = $('.dropdown', menu)
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
  const hash = location.hash || '#/'
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === hash)
  })
  if (hash === '#/login') return site.user ? (location.hash = '#/') : renderLogin()
  if (hash === '#/account') return renderAccount()
  if (hash === '#/settings') return renderSettings()
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
      el2.textContent = `💕 第 ${days} 天`
      el2.hidden = false
    }
  }
  renderUserArea()
  route()
}

window.addEventListener('hashchange', route)
init()
