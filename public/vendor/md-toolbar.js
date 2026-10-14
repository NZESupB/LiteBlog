// Markdown 工具栏(自实现,零依赖)
// 通过 data-md 声明操作类型;选区包裹/行前缀/光标处插入,尽量保留撤销栈(execCommand),失败回退 setRangeText
import { animatePresence } from '/js/sheet-motion.js'
const $ = (s, el) => el.querySelector(s)

// 在保留原生撤销栈的前提下替换选区内容;不支持时回退 setRangeText
function replaceSelection(ta, text) {
  ta.focus()
  try {
    // execCommand 虽废弃但仍是最可靠保留 undo 栈的方式
    if (document.execCommand && document.execCommand('insertText', false, text)) return
  } catch {}
  const { selectionStart: s, selectionEnd: e, value } = ta
  ta.setRangeText(text, s, e, 'end')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

// 选区两侧包裹标记;再次触发同标记时取消包裹
function wrapSelection(ta, before, after = before, placeholder = '') {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const sel = value.slice(s, e) || placeholder
  const already = value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after
  if (already) {
    ta.setRangeText(sel, s - before.length, e + after.length, 'select')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  replaceSelection(ta, before + sel + after)
  ta.setSelectionRange(s + before.length, s + before.length + sel.length)
}

// 对选区覆盖到的每一行加/去前缀;前缀可为字符串或按行号生成(有序列表)
function prefixLines(ta, prefix, ordered = false) {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const start = value.lastIndexOf('\n', s - 1) + 1
  const end = value.indexOf('\n', e)
  const block = value.slice(start, end === -1 ? value.length : end)
  const lines = block.split('\n')
  const testRe = ordered ? /^\d+\.\s/ : new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const has = lines.every((l) => l.trim() === '' || testRe.test(l))
  const next = lines
    .map((l, i) => {
      if (l.trim() === '') return l
      if (has) return l.replace(testRe, '')
      return (ordered ? `${i + 1}. ` : prefix) + l
    })
    .join('\n')
  ta.setRangeText(next, start, end === -1 ? value.length : end, 'select')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

function insertBlock(ta, text) {
  const { selectionStart: s, value } = ta
  const atLineStart = s === 0 || value[s - 1] === '\n'
  replaceSelection(ta, (atLineStart ? '' : '\n') + text)
}

function promptLink(ta) {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const sel = value.slice(s, e) || '链接文字'
  const url = prompt('链接地址 (https://…)')
  if (!url) return
  replaceSelection(ta, `[${sel}](${url})`)
  ta.setSelectionRange(s + 1, s + 1 + sel.length)
}

const ACTIONS = {
  bold: (ta) => wrapSelection(ta, '**', '**', '加粗'),
  italic: (ta) => wrapSelection(ta, '*', '*', '斜体'),
  strikethrough: (ta) => wrapSelection(ta, '~~', '~~'),
  heading: (ta) => prefixLines(ta, '### '),
  quote: (ta) => prefixLines(ta, '> '),
  'code-inline': (ta) => wrapSelection(ta, '`', '`', '代码'),
  'code-block': (ta) => wrapSelection(ta, '\n```\n', '\n```\n', '代码块'),
  link: promptLink,
  'list-ul': (ta) => prefixLines(ta, '- '),
  'list-ol': (ta) => prefixLines(ta, '', true),
  tasklist: (ta) => prefixLines(ta, '- [ ] '),
  emoji: toggleEmojiPanel,
}

// 常用表情
const EMOJIS = '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 🤔 🫡 🤗 😴 🥺 😢 😭 😤 😡 🤬 😱 😮 😲 🫠 😶‍🌫️ ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💕 💞 💓 💗 💖 💘 💝 💟 👍 👎 👏 🙌 👐 🤝 💪 🔥 ✨ 🎉 🎊 🌹 🌸 🌞 🌙 ⭐ 🎈 🍰 🍷 ☕ 🍽️ 📷 🌈 🍃 🐱 🐶'.split(' ')

let emojiPanel = null
let emojiPanelSeq = 0

function coarsePointer() {
  return Boolean(window.matchMedia?.('(pointer: coarse)')?.matches)
}

function keyboardInset() {
  const viewport = window.visualViewport
  if (!viewport) return 0
  return Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
}

function keepInputAbovePanel(input, panel) {
  const panelTop = panel.getBoundingClientRect().top
  const inputRect = input.getBoundingClientRect()
  const delta = inputRect.bottom - (panelTop - 12)
  if (delta <= 0) return
  const scroller = input.closest?.('.composer-body')
  if (scroller && scroller.scrollHeight > scroller.clientHeight) {
    scroller.scrollTop += delta
    return
  }
  const root = document.scrollingElement || document.documentElement
  if (root) root.scrollTop += delta
}

export function closeEmojiPanel(immediate = false) {
  if (!emojiPanel) return false
  emojiPanel.close({ immediate })
  return true
}

// 表情面板:textarea 与单行 input 通用。鼠标设备锚在触发按钮旁;触屏设备用底部表情盘,
// 打开时先收起键盘,选择后把焦点交还输入框。两种形态都不参与表单排版。
function toggleEmojiPanel(ta, trigger) {
  if (emojiPanel) {
    const current = emojiPanel
    if (current.input === ta && current.trigger === trigger) {
      current.close({ restoreKeyboard: current.coarse })
      return
    }
    current.close({ immediate: true })
  }

  const panel = document.createElement('div')
  const coarse = coarsePointer()
  const panelId = `emoji-panel-${++emojiPanelSeq}`
  panel.id = panelId
  panel.className = `emoji-panel ${coarse ? 'emoji-panel-tray' : 'emoji-panel-popover'}`
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '选择表情')
  panel.innerHTML = `<div class="emoji-panel-surface">
    <div class="emoji-panel-head"><strong>表情</strong><button class="emoji-panel-close" type="button" aria-label="关闭表情面板">×</button></div>
    <div class="emoji-grid">${EMOJIS.map((e) => `<button type="button" class="emoji-btn">${e}</button>`).join('')}</div>
  </div>`

  trigger?.setAttribute('aria-haspopup', 'dialog')
  trigger?.setAttribute('aria-controls', panelId)
  trigger?.setAttribute('aria-expanded', 'true')
  document.body.appendChild(panel)
  panel.hidden = false

  let frame = 0
  let closed = false

  const positionPopover = () => {
    if (coarse || panel.hidden) return
    const rect = trigger.getBoundingClientRect()
    const width = panel.offsetWidth || 360
    const height = panel.offsetHeight || 240
    const gap = 8
    const padding = 8
    const aboveSpace = rect.top - gap - padding
    const belowSpace = window.innerHeight - rect.bottom - gap - padding
    const above = aboveSpace >= height || (belowSpace < height && aboveSpace > belowSpace)
    const top = above
      ? Math.max(padding, rect.top - gap - height)
      : Math.min(window.innerHeight - padding - height, rect.bottom + gap)
    const left = Math.max(padding, Math.min(window.innerWidth - padding - width, rect.right - width))
    const originX = Math.max(12, Math.min(width - 12, rect.left + rect.width / 2 - left))
    panel.style.left = `${left}px`
    panel.style.top = `${Math.max(padding, top)}px`
    panel.style.transformOrigin = `${originX}px ${above ? '100%' : '0%'}`
  }

  const syncTray = () => {
    frame = 0
    if (closed || !coarse || !panel.isConnected) return
    panel.style.setProperty('--emoji-keyboard-offset', `${keyboardInset()}px`)
    keepInputAbovePanel(ta, panel)
  }
  const scheduleTray = () => {
    if (!frame && !closed) frame = requestAnimationFrame(syncTray)
  }
  const closer = (event) => {
    if (panel.contains(event.target) || trigger?.contains(event.target)) return
    closePanel()
  }
  const onKeydown = (event) => {
    if (event.key === 'Escape') closePanel()
  }
  const removeListeners = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    window.removeEventListener('resize', onWindowChange)
    window.removeEventListener('scroll', positionPopover, true)
    window.visualViewport?.removeEventListener('resize', scheduleTray)
    window.visualViewport?.removeEventListener('scroll', scheduleTray)
    document.removeEventListener('click', closer)
    document.removeEventListener('keydown', onKeydown)
  }
  const closePanel = ({ immediate = false, restoreKeyboard = false } = {}) => {
    if (closed) return
    closed = true
    removeListeners()
    trigger?.setAttribute('aria-expanded', 'false')
    if (restoreKeyboard) ta.focus({ preventScroll: true })
    animatePresence(panel, false, {
      className: 'emoji-panel-presence',
      duration: 180,
      immediate,
      remove: true,
      onComplete() {
        cancelAnimationFrame(frame)
        document.body.classList.remove('emoji-tray-open')
        if (emojiPanel?.panel === panel) emojiPanel = null
      },
    })
  }
  const onWindowChange = () => {
    if (coarse) scheduleTray()
    else positionPopover()
  }

  panel.addEventListener('click', (event) => {
    if (event.target.closest('.emoji-panel-close')) {
      event.preventDefault()
      closePanel()
      return
    }
    const btn = event.target.closest('.emoji-btn')
    if (!btn) return
    event.preventDefault()
    event.stopPropagation()
    replaceSelection(ta, btn.textContent)
    closePanel({ restoreKeyboard: true })
  })

  if (coarse) {
    document.body.classList.add('emoji-tray-open')
    panel.style.setProperty('--emoji-keyboard-offset', `${keyboardInset()}px`)
    ta.blur()
    window.visualViewport?.addEventListener('resize', scheduleTray)
    window.visualViewport?.addEventListener('scroll', scheduleTray)
    scheduleTray()
  } else {
    panel.style.visibility = 'hidden'
    positionPopover()
    panel.style.visibility = ''
    window.addEventListener('scroll', positionPopover, true)
  }
  window.addEventListener('resize', onWindowChange)
  setTimeout(() => {
    if (closed) return
    document.addEventListener('click', closer)
  }, 0)
  document.addEventListener('keydown', onKeydown)

  emojiPanel = { panel, input: ta, trigger, coarse, close: closePanel }
  animatePresence(panel, true, { className: 'emoji-panel-presence', duration: 220 })
}

// 给任意输入框挂表情按钮(评论框等,不带完整 Markdown 工具栏时用)
export function attachEmojiButton(btn, input) {
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    toggleEmojiPanel(input, btn)
  })
}

export function attachMdToolbar(toolbar, textarea) {
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-md]')
    if (!btn) return
    e.preventDefault()
    ACTIONS[btn.dataset.md]?.(textarea, btn)
  })
  // 快捷键:Cmd/Ctrl+B 加粗,Cmd/Ctrl+I 斜体,Cmd/Ctrl+K 链接
  textarea.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const map = { b: 'bold', i: 'italic', k: 'link' }
    const action = map[e.key.toLowerCase()]
    if (!action) return
    e.preventDefault()
    ACTIONS[action](textarea)
  })
}
