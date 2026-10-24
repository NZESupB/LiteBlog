import { animatePresence, animateElement } from './motion.js'
import { replaceSelection } from './text-selection.js'

const EMOJI_TEXT = `
😀 😃 😄 😁 😆 😅 😂 🤣 🥹 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚
😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖
😫 😩 🥺 😢 😭 😮‍💨 😤 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🫠 😶‍🌫️
🤔 🫡 🤗 🤫 🫢 🤭 🥱 😴 🤤 😷 🤒 🤕 🤢 🤮 🤧 🥴 😵 🤐 🤠 🤡
❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💕 💞 💓 💗 💖 💘 💝 💟
👍 👎 👏 🙌 👐 🫶 🤝 👊 ✊ 🤛 🤜 🤞 ✌️ 🫰 🤟 🤘 👌 🤌 🤏 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 ✍️ 🤳 🙏 💅
💪 🦵 🦶 👂 👃 👁️ 👀 🧠 🫀 🫁 🦷 👅 👄
🔥 ✨ 🌟 💫 💥 💢 💯 💤 💨 🎉 🎊 🎈 🎁 🎀 🪅 🎐 🧧 💌 💬 💭
🌸 🌹 🌺 🌻 🌼 🌷 🍀 🍃 🍁 🍂 🌾 🌞 🌙 ⭐ ☀️ 🌤️ ⛅ 🌧️ ⛈️ ❄️ 🌈
🐱 🐶 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐧 🐦 🐣 🦆 🦉 🦋 🐝 🐢 🐬 🐳
☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🍸 🍹 🍰 🎂 🍦 🍧 🍨 🍩 🍪 🍫 🍬 🍭 🍮 🍯 🥐 🍞 🥖 🥨 🥯 🥞 🧇 🧀 🍗 🥩 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥮 🍢 🍡 🍓 🍒 🍎 🍉 🍑 🍊 🍋 🍍 🍌 🥑 🍅 🍇
✈️ 🚗 🚲 🛵 🚂 🏠 🏕️ 🏖️ 🏙️ ⛰️ 🏔️ 🎡 🎢 🎨 🎬 🎤 🎧 🎼 🎹 🎸 🥁 🎮 🎯 🎲 📷 📸 📖 📚 ✏️ 📝 💡 ⏰ 🧭 🗝️ 🪄
`
const EMOJIS = EMOJI_TEXT.trim().split(/\s+/).filter(Boolean)
let current = null
let sequence = 0
const keyboardInset = (host) => {
  const viewport = window.visualViewport
  const bottom = host === document.body ? window.innerHeight : host.getBoundingClientRect().bottom
  return viewport ? Math.max(0, bottom - viewport.height - viewport.offsetTop) : 0
}
function dockVisible(visible) {
  const dock = document.querySelector('.mobile-nav')
  if (!dock) return
  dock.inert = !visible
  animateElement(dock, {
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateX(-50%)' : 'translate(-50%, calc(100% + 24px))',
  })
}
export function closeEmojiPanel(immediate = false) {
  if (!current) return false
  current.close({ immediate })
  return true
}

// 挂在所属原生 dialog 内，保留模态焦点边界；评论入口才挂 body。
export function toggleEmojiPanel(input, trigger) {
  if (current) {
    if (current.input === input && current.trigger === trigger) {
      current.close()
      return
    }
    current.close({ immediate: true })
  }
  const coarse = Boolean(window.matchMedia('(pointer: coarse)').matches)
  const panel = document.createElement('div')
  const host = input.closest('dialog') || document.body
  panel.id = `emoji-panel-${++sequence}`
  panel.className = `emoji-panel ${coarse ? 'emoji-panel-tray' : 'emoji-panel-popover'}`
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '选择表情')
  panel.innerHTML = `<div class="emoji-panel-surface"><div class="emoji-panel-head"><strong>表情</strong><button class="emoji-panel-close" type="button" aria-label="关闭表情面板">×</button></div><div class="emoji-grid">${EMOJIS.map((emoji) => `<button type="button" class="emoji-btn">${emoji}</button>`).join('')}</div></div>`
  for (const [name, value] of Object.entries({
    'aria-haspopup': 'dialog',
    'aria-controls': panel.id,
    'aria-expanded': 'true',
  }))
    trigger.setAttribute(name, value)
  let backdrop = null
  if (coarse) {
    backdrop = document.createElement('div')
    backdrop.className = 'emoji-panel-backdrop'
    backdrop.style.cssText =
      'position:fixed;inset:0;z-index:79;background:rgba(0,0,0,0.18);-webkit-tap-highlight-color:transparent;'
    host.appendChild(backdrop)
  }
  host.appendChild(panel)
  let frame = 0,
    closed = false
  const listeners = new AbortController()
  const position = () => {
    if (closed || !panel.isConnected) return
    if (coarse) {
      panel.style.setProperty('--emoji-keyboard-offset', `${keyboardInset(host)}px`)
      const delta = input.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + 12
      if (delta > 0) {
        const scroller = input.closest('.composer-body') || document.scrollingElement
        scroller.scrollTop += delta
      }
      return
    }
    const rect = trigger.getBoundingClientRect()
    const width = panel.offsetWidth,
      height = panel.offsetHeight,
      padding = 8
    const above =
      rect.top - 16 >= height ||
      (window.innerHeight - rect.bottom - 16 < height && rect.top > window.innerHeight - rect.bottom)
    const top = above ? rect.top - height - padding : rect.bottom + padding
    const left = Math.max(padding, Math.min(window.innerWidth - padding - width, rect.right - width))
    panel.style.left = `${left}px`
    panel.style.top = `${Math.max(padding, Math.min(window.innerHeight - height - padding, top))}px`
    panel.style.transformOrigin = `${Math.max(12, Math.min(width - 12, rect.left + rect.width / 2 - left))}px ${above ? '100%' : '0%'}`
  }
  const schedule = () => {
    if (!frame && !closed)
      frame = requestAnimationFrame(() => {
        frame = 0
        position()
      })
  }
  const close = ({ immediate = false, restoreFocus = true } = {}) => {
    if (closed) {
      if (immediate) {
        if (backdrop) backdrop.remove()
        animatePresence(panel, false, { className: 'emoji-panel-presence', remove: true, immediate: true })
      }
      return
    }
    closed = true
    listeners.abort()
    cancelAnimationFrame(frame)
    trigger.setAttribute('aria-expanded', 'false')
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true })
    if (coarse) dockVisible(true)
    if (backdrop) {
      backdrop.remove()
      backdrop = null
    }
    animatePresence(panel, false, {
      className: 'emoji-panel-presence',
      duration: 180,
      remove: true,
      immediate,
      onComplete() {
        if (current?.panel === panel) current = null
      },
    })
  }
  current = { panel, input, trigger, close }
  if (backdrop) {
    const dismissBackdrop = (event) => {
      event.preventDefault()
      event.stopPropagation()
      close({ restoreFocus: false })
    }
    backdrop.addEventListener('click', dismissBackdrop, { signal: listeners.signal })
    backdrop.addEventListener('pointerdown', dismissBackdrop, { signal: listeners.signal })
  }
  panel.addEventListener(
    'pointerdown',
    (event) => {
      if (event.target.closest('.emoji-panel-close')) {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    },
    { signal: listeners.signal },
  )
  panel.addEventListener(
    'click',
    (event) => {
      event.stopPropagation()
      if (event.target.closest('.emoji-panel-close')) {
        close()
        return
      }
      const button = event.target.closest('.emoji-btn')
      if (button) {
        replaceSelection(input, button.textContent)
        close({ restoreFocus: false })
      }
    },
    { signal: listeners.signal },
  )
  const onOutside = (event) => {
    if (
      !panel.contains(event.target) &&
      !trigger.contains(event.target) &&
      (!backdrop || event.target !== backdrop)
    ) {
      close({ restoreFocus: false })
    }
  }
  document.addEventListener('pointerdown', onOutside, { signal: listeners.signal })
  document.addEventListener('click', onOutside, { signal: listeners.signal })
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    },
    { signal: listeners.signal, capture: true },
  )
  window.addEventListener('resize', schedule, { signal: listeners.signal })
  window.addEventListener('scroll', schedule, { signal: listeners.signal, capture: true })
  window.visualViewport?.addEventListener('resize', schedule, { signal: listeners.signal })
  window.visualViewport?.addEventListener('scroll', schedule, { signal: listeners.signal })
  if (coarse) {
    input.blur()
    dockVisible(false)
  }
  position()
  animatePresence(panel, true, { className: 'emoji-panel-presence' })
  panel.querySelector('.emoji-btn')?.focus({ preventScroll: true })
}

export function attachEmojiButton(button, input) {
  const click = (event) => {
    event.preventDefault()
    toggleEmojiPanel(input, button)
  }
  button.addEventListener('click', click)
  return () => button.removeEventListener('click', click)
}
