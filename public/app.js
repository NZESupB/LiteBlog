// 前端逻辑:hash 路由 + 时间轴 / 相册 / 登录 / 设置 视图
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
      </div>
      <textarea placeholder="记录一下今天的小事…(支持 Markdown)"></textarea>
      <div class="preview-grid"></div>
      <div class="form-error"></div>
      <div class="compose-actions">
        <button class="btn-ghost pick">📷 图片</button>
        <span class="spacer"></span>
        ${post ? '<button class="btn-ghost cancel">取消</button>' : ''}
        <button class="btn submit">${post ? '保存' : '发布'}</button>
      </div>
      <input type="file" accept="image/*" multiple hidden />
    </div>`)
  const textarea = $('textarea', card)
  attachMdToolbar($('.md-toolbar', card), textarea)
  const previews = $('.preview-grid', card)
  const fileInput = $('input[type=file]', card)
  const errorLine = $('.form-error', card)
  const submitBtn = $('.submit', card)

  textarea.value = post ? post.content : ''
  const keepImages = post ? post.images.map((img) => ({ ...img })) : [] // 保留的已有图片
  const newFiles = [] // 新增文件

  function renderPreviews() {
    previews.innerHTML = ''
    for (const [list, i, src] of [
      ...keepImages.map((img, i) => [keepImages, i, img.url]),
      ...newFiles.map((f, i) => [newFiles, i, f._url]),
    ]) {
      const item = el(`<div class="preview-item"><img src="${src}" alt="" /><button class="remove">×</button></div>`)
      $('.remove', item).onclick = () => { list.splice(i, 1); renderPreviews() }
      previews.appendChild(item)
    }
  }
  renderPreviews()

  $('.pick', card).onclick = () => fileInput.click()
  fileInput.onchange = async () => {
    for (const f of fileInput.files) {
      const c = await compressImage(f)
      c._url = URL.createObjectURL(c)
      newFiles.push(c)
    }
    fileInput.value = ''
    renderPreviews()
  }

  submitBtn.onclick = async () => {
    const content = textarea.value.trim()
    if (!content && keepImages.length + newFiles.length === 0) {
      errorLine.textContent = '写点什么或传张图吧'
      return
    }
    submitBtn.disabled = true
    errorLine.textContent = ''
    try {
      const form = new FormData()
      form.append('content', content)
      if (post) form.append('keep', JSON.stringify(keepImages.map((img) => img.id)))
      for (const f of newFiles) form.append('images', f)
      await api(post ? `/api/posts/${post.id}` : '/api/posts', { method: post ? 'PUT' : 'POST', body: form })
      onDone()
    } catch (e) {
      errorLine.textContent = e.message
      submitBtn.disabled = false
    }
  }
  if (post) $('.cancel', card).onclick = onCancel
  return card
}

// ---------- 时间轴视图 ----------

function renderPost(p) {
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

  if (p.content) $('.post-content', card).innerHTML = marked.parse(p.content)
  else $('.post-content', card).remove()

  const grid = $('.img-grid', card)
  const urls = p.images.map((img) => img.url)
  p.images.forEach((img, i) => {
    const image = el(`<img src="${img.url}" alt="" loading="lazy" />`)
    image.onclick = () => openLightbox(urls, i)
    grid.appendChild(image)
  })

  if (site.user && site.user.id === p.user_id) {
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
  const card = el(`
    <div class="card login-card">
      <h2>${esc(site.title)}</h2>
      <div class="sub">${site.privateMode ? '这是我们的私密小站,请先登录' : '登录后可以发布动态'}</div>
      <input name="name" placeholder="昵称" autocomplete="username" />
      <input name="password" type="password" placeholder="密码" autocomplete="current-password" />
      <div class="form-error"></div>
      <button class="btn">登录</button>
    </div>`)
  const doLogin = async () => {
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: $('[name=name]', card).value.trim(), password: $('[name=password]', card).value }),
      })
      location.hash = '#/'
      location.reload()
    } catch (e) {
      $('.form-error', card).textContent = e.message
    }
  }
  $('.btn', card).onclick = doLogin
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin() })
  main.appendChild(card)
}

// ---------- 设置视图(登录后可见,即时生效) ----------

function renderSettings() {
  if (!site.user) return renderLogin()
  main.innerHTML = ''
  const card = el(`
    <div class="card settings-card">
      <h2>站点设置</h2>
      <label>站点名称<input name="title" value="${esc(site.title)}" /></label>
      <label>纪念日(在一起日期)<input name="anniversary" type="date" value="${esc(site.anniversary)}" /></label>
      <label class="row">
        <input name="privateMode" type="checkbox" ${site.privateMode ? 'checked' : ''} />
        <span>私密模式(访客必须登录才能浏览)</span>
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
}

// ---------- 顶栏与路由 ----------

function renderUserArea() {
  const area = $('#userArea')
  area.innerHTML = ''
  if (!site.user) {
    area.appendChild(el('<a href="#/login">登录</a>'))
    return
  }
  // 头像 + 下拉菜单:设置 / 改密码 / 退出
  const menu = el(`
    <div class="user-menu">
      <button class="avatar-btn" aria-haspopup="true" aria-expanded="false">
        <span class="avatar small" style="background:${avatarColor(site.user.name)}">${esc(site.user.name[0])}</span>
      </button>
      <div class="dropdown" hidden>
        <div class="dropdown-name">${esc(site.user.name)}</div>
        <a href="#/settings" class="dropdown-item">⚙️ 站点设置</a>
        <button class="dropdown-item chpw">🔑 修改密码</button>
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
  $('.dropdown-item[href="#/settings"]', menu).onclick = () => (drop.hidden = true)
  $('.chpw', menu).onclick = async () => {
    drop.hidden = true
    const oldPassword = prompt('请输入原密码')
    if (oldPassword === null) return
    const newPassword = prompt('请输入新密码(至少 6 位)')
    if (newPassword === null) return
    try {
      await api('/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      alert('密码已修改')
    } catch (e) {
      alert(e.message)
    }
  }
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
  if (site.privateMode && !site.user) return renderLogin()
  if (hash === '#/login') return site.user ? (location.hash = '#/') : renderLogin()
  if (hash === '#/settings') return renderSettings()
  if (hash === '#/gallery') return renderGallery()
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
      el2.textContent = `💕 在一起 ${days} 天`
      el2.hidden = false
    }
  }
  renderUserArea()
  route()
}

window.addEventListener('hashchange', route)
init()
