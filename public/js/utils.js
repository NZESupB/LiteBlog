// 纯工具函数:不依赖页面状态与 DOM 结构,供 app.js 及后续拆分的视图模块共用
const AVATAR_COLORS = ['#e8747c', '#7ca9e8', '#8ec9a0', '#c99be0', '#e8b06e']

export async function api(path, opts = {}) {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `请求失败 (${res.status})`)
  return data
}

// SSE 流式请求:服务端协议为 data:{"delta"} / data:{"error"} / data:[DONE]
// 上游失败时服务端仍回普通 JSON 错误,所以这里按 res.ok 分流,错误语义与 api() 一致
export async function streamSse(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    const error = new Error(data.error || data.message || `请求失败 (${res.status})`)
    error.code = data.code || ''
    throw error
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
        if (evt.error) {
          const error = new Error(evt.error)
          error.code = evt.code || ''
          throw error
        }
        onEvent(evt)
      }
    }
  }
}

export function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function setFormMessage(element, message, state = 'error') {
  element.textContent = message
  element.dataset.state = message ? state : ''
}

export function avatarColor(name) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

// SQLite 存的是 UTC,转本地时间展示
export function parseTime(s) {
  return new Date(s.replace(' ', 'T') + 'Z')
}

export function formatTime(s) {
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

export function dateLabel(s) {
  const d = parseTime(s)
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 周${week}`
}
