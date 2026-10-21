// 常规交互唯一动效入口；插值、时间轴和底层动画执行统一交给本地 Motion。
const owners = new WeakMap()
const presences = new WeakMap()
const running = new Set()
let preference
export const motionEasing = Object.freeze({
  out: Object.freeze([0.23, 1, 0.32, 1]),
  move: Object.freeze([0.77, 0, 0.175, 1]),
})
export const motionTiming = Object.freeze({
  fast: 120, standard: 220, dialog: 260, ease: motionEasing.out,
  press: 100, release: 160, selection: 180, content: 160,
  imageOpen: 260, imageClose: 220, imageOut: 100, imageIn: 160,
  backdrop: 180, settings: 220,
})

export function prefersReducedMotion() {
  if (!preference && globalThis.window?.matchMedia) {
    preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    preference.addEventListener?.('change', () => {
      if (preference.matches) for (const animation of [...running]) animation.finish()
    })
  }
  return Boolean(preference?.matches)
}

function apply(node, values) {
  for (const [key, value] of Object.entries(values)) {
    const final = Array.isArray(value) ? value.at(-1) : value
    if (key.startsWith('--')) node.style.setProperty(key, final)
    else node.style[key] = final
  }
}

export function animateElement(node, values, { duration = motionTiming.standard, easing = motionEasing.out, initial, immediate = false, onComplete, channel = 'default' } = {}) {
  const channels = owners.get(node) || new Map()
  channels.get(channel)?.cancel('interrupted')
  if (initial) apply(node, initial)
  let controls, settled = false, resolve
  const finished = new Promise((done) => { resolve = done })
  const settle = (status) => {
    if (settled) return
    settled = true
    running.delete(animation)
    if (channels.get(channel) === animation) channels.delete(channel)
    if (!channels.size) owners.delete(node)
    resolve({ status })
    if (status === 'finished') onComplete?.()
  }
  const animation = {
    node, finished,
    cancel(status = 'interrupted') { if (!settled) { controls?.stop(); settle(status) } },
    finish() { if (!settled) { controls?.stop(); apply(node, values); settle('finished') } },
  }
  channels.set(channel, animation)
  owners.set(node, channels)
  running.add(animation)
  if (immediate || prefersReducedMotion() || duration === 0) {
    animation.finish()
  } else {
    if (!globalThis.Motion?.animate) {
      animation.cancel('disposed')
      throw new Error('本地 Motion 未加载，请检查静态资源。')
    }
    try {
      controls = Motion.animate(node, values, { duration: duration / 1000, ease: easing })
      controls.then(() => settle('finished'))
    } catch (error) {
      animation.cancel('disposed')
      throw error
    }
  }
  return animation
}

// presence 成对声明视觉:out 为隐藏态,entered 为静止态。
// entered 的 transform 不能写 'none' —— 本地 Motion 把非矩阵字符串当成"各分量 0",
// 插值结果恒为 matrix(0,0,0,0,0,0)(即 scale(0)),节点会被钉成 0 尺寸而消失。
// toast/bubble 的静止态还必须保留自身位移,否则居中定位会被一并抹掉。
const presets = {
  'menu-presence': { out: { opacity: 0, transform: 'translateY(-6px) scale(.98)' }, entered: { opacity: 1, transform: 'translateY(0) scale(1)' } },
  'panel-presence': { out: { opacity: 0, transform: 'translateY(6px) scale(.99)' }, entered: { opacity: 1, transform: 'translateY(0) scale(1)' } },
  'bubble-presence': { out: { opacity: 0, transform: 'translateY(calc(-50% + 5px)) scale(.98)' }, entered: { opacity: 1, transform: 'translateY(-50%) scale(1)' } },
  'toast-presence': { out: { opacity: 0, transform: 'translate(-50%, 8px) scale(.98)' }, entered: { opacity: 1, transform: 'translate(-50%, 0) scale(1)' } },
  'lightbox-presence': { out: { opacity: 0 }, entered: { opacity: 1 } },
  'overlay-presence': { out: { opacity: 0 }, entered: { opacity: 1 } },
  'dialog-presence': { out: { opacity: 0, transform: 'translateY(12px) scale(.98)' }, entered: { opacity: 1, transform: 'translateY(0) scale(1)' } },
  'emoji-panel-presence': { out: { opacity: 0, transform: 'translateY(4px) scale(.98)' }, entered: { opacity: 1, transform: 'translateY(0) scale(1)' } },
  'header-write-presence': {
    out: { opacity: 0, transform: 'translateY(-4px) scale(.98)', maxWidth: '0px', marginLeft: '-14px', marginRight: '-14px' },
    entered: { opacity: 1, transform: 'translateY(0) scale(1)', maxWidth: '150px', marginLeft: '0px', marginRight: '0px' },
  },
}
// 表情面板只动内部托盘,不含透明度。
const emojiTrayPreset = { out: { transform: 'translateY(110%)' }, entered: { transform: 'translateY(0)' } }

export function animatePresence(node, visible, {
  className = 'panel-presence', duration = motionTiming.standard,
  remove = false, hidden = true, immediate = false, onComplete, easing = motionEasing.out,
} = {}) {
  if (!node) return Promise.resolve({ status: 'disposed' })
  let state = presences.get(node)
  if (state?.visible === visible && !immediate) return state.promise
  if (!state) {
    state = { visible: false, inert: node.inert || false }
    presences.set(node, state)
  }
  const first = !node.classList.contains(className)
  const wasHidden = node.hidden
  state.visible = visible
  const present = `${className}-present`
  const closing = `${className}-closing`
  node.classList.add(className)
  node.classList.toggle(present, visible)
  node.classList.toggle(closing, !visible)
  node.inert = visible ? state.inert : true
  const targetNode = className === 'emoji-panel-presence' && node.classList.contains('emoji-panel-tray')
    ? node.querySelector('.emoji-panel-surface') : node
  const { out, entered } = targetNode !== node
    ? emojiTrayPreset
    : (presets[className] || { out: { opacity: 0 }, entered: { opacity: 1 } })
  const reduced = prefersReducedMotion()
  const initial = visible && (wasHidden || first) ? { ...out } : undefined
  const target = { ...(visible ? entered : out) }
  if (reduced && target.transform) {
    target.transform = entered.transform
    if (initial) initial.transform = entered.transform
  }
  if (visible && hidden) node.hidden = false
  state.animation = animateElement(targetNode, target, {
    initial, duration, immediate, easing,
    onComplete() {
      if (!visible) {
        if (remove) node.remove()
        else if (hidden) node.hidden = true
        node.classList.remove(className, present, closing)
      }
      onComplete?.()
    },
  })
  state.promise = state.animation.finished
  return state.promise
}

export function disposeAnimations(root) {
  for (const animation of [...running]) {
    if (animation.node === root || root.contains?.(animation.node)) animation.cancel('disposed')
  }
  const reset = (node) => {
    const state = presences.get(node)
    if (state) node.inert = state.inert
    presences.delete(node)
  }
  reset(root)
  for (const node of root.querySelectorAll?.('[class*="-presence"]') || []) reset(node)
}

// 静止态写 translateY(0) 而不是 'none':本地 Motion 会用目标值的函数结构去套源值的
// 数字,'none' 这类非矩阵字符串被当成"各分量 0",插值结果恒为 matrix(0,0,0,0,0,0),
// 节点被永久钉在 scale(0) —— 表现为整块内容消失(登录页白屏),刷新后才恢复。
export function revealElement(node) {
  animateElement(node, { opacity: 1, transform: 'translateY(0)' }, {
    initial: { opacity: 0, transform: prefersReducedMotion() ? 'translateY(0)' : 'translateY(8px)' },
  })
}

export function highlightElement(node) {
  return animateElement(node, { backgroundColor: ['transparent', getComputedStyle(node).getPropertyValue('--accent-soft').trim(), 'transparent'] }, { duration: 1600 })
}

// 独立 scale 属性保留按钮原有定位变换；不把中途的缩放矩阵当作下一次按压的基准。
export function installPressMotion(root = document) {
  let pressed = null
  const release = () => {
    if (!pressed) return
    const node = pressed
    pressed = null
    if (node.isConnected) animateElement(node, { '--press-scale': 1 }, { duration: motionTiming.release, channel: 'press' })
  }
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || prefersReducedMotion()) return
    const node = event.target.closest?.('button, a.btn, a.btn-ghost, .mobile-nav a')
    if (!node || node.disabled || node.closest('[inert]')) return
    release()
    node.setAttribute('data-press-motion', '')
    pressed = node
    animateElement(node, { '--press-scale': .97 }, { duration: motionTiming.press, channel: 'press' })
  })
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(name, release)
}
