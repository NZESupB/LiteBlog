// 临界阻尼的解析解：更新目标时保留当前位移与速度，不依赖固定时长过渡。
export function stepSpring(position, velocity, target, seconds, response = .32) {
  const omega = 2 * Math.PI / response
  const displacement = position - target
  const b = velocity + omega * displacement
  const decay = Math.exp(-omega * seconds)
  return {
    position: target + (displacement + b * seconds) * decay,
    velocity: (velocity - omega * b * seconds) * decay,
  }
}

// Apple 的滚动投影公式：释放时把当前速度换算成预计会到达的位置。
export function projectMomentum(initialVelocity, decelerationRate = .998) {
  const rate = Math.min(.9999, Math.max(.9, Number(decelerationRate) || .998))
  return (Number(initialVelocity) || 0) / 1000 * rate / (1 - rate)
}

function reducedMotionValue(source) {
  if (typeof source === 'function') return Boolean(source())
  if (typeof source === 'boolean') return source
  if (source && typeof source.matches === 'boolean') return source.matches
  return Boolean(globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
}

// 通用可中断弹簧。retarget() 永远从当前 presentation value 继续，
// stop() 只停帧而不改当前位置，适合手势接管和快速反向操作。
export function createSpringController({
  value = 0,
  target = value,
  response = .34,
  reducedMotion = null,
  onUpdate = () => {},
  onRest = () => {},
} = {}) {
  let position = Number(value) || 0
  let velocity = 0
  let destination = Number(target) || 0
  let frame = 0
  let previousTime = 0
  let disposed = false
  let resting = position === destination

  const notify = () => onUpdate(position, velocity, destination)
  const finish = () => {
    if (resting) return
    position = destination
    velocity = 0
    resting = true
    notify()
    onRest(destination)
  }
  const tick = (time) => {
    frame = 0
    if (disposed) return
    if (reducedMotionValue(reducedMotion)) {
      finish()
      return
    }
    const seconds = previousTime ? Math.min(.05, Math.max(0, (time - previousTime) / 1000)) : 0
    previousTime = time
    const next = stepSpring(position, velocity, destination, seconds, response)
    position = next.position
    velocity = next.velocity
    notify()
    if (Math.abs(position - destination) < .25 && Math.abs(velocity) < 4) {
      finish()
      return
    }
    frame = globalThis.requestAnimationFrame(tick)
  }
  const schedule = () => {
    if (frame || disposed) return
    previousTime = globalThis.performance?.now?.() ?? 0
    frame = globalThis.requestAnimationFrame(tick)
  }
  const retarget = (nextTarget, nextVelocity = null) => {
    destination = Number(nextTarget) || 0
    if (nextVelocity !== null && Number.isFinite(Number(nextVelocity))) velocity = Number(nextVelocity)
    resting = false
    if (reducedMotionValue(reducedMotion)) {
      finish()
      return
    }
    schedule()
  }
  const stop = () => {
    if (frame) globalThis.cancelAnimationFrame(frame)
    frame = 0
    previousTime = 0
  }
  const set = (nextPosition, nextVelocity = 0) => {
    stop()
    position = Number(nextPosition) || 0
    velocity = Number(nextVelocity) || 0
    destination = position
    resting = true
    notify()
  }
  notify()
  return {
    retarget,
    stop,
    set,
    getValue: () => position,
    getVelocity: () => velocity,
    getTarget: () => destination,
    isAnimating: () => Boolean(frame),
    dispose() {
      disposed = true
      stop()
    },
  }
}

const presenceStates = new WeakMap()

// Presence 动效负责 hidden/remove 的时序。重复调用会取消上一段退出，
// 让快速打开/关闭从当前 CSS presentation state 接续，而不会留下幽灵节点。
export function animatePresence(node, visible, {
  className = 'motion-presence',
  duration = 220,
  remove = false,
  hidden = true,
  immediate = false,
  reducedMotion = null,
  onComplete = null,
} = {}) {
  if (!node) return Promise.resolve()
  let state = presenceStates.get(node)
  if (!state) {
    state = { token: 0, timer: null, className, remove, hidden }
    presenceStates.set(node, state)
  }
  state.className = className
  state.remove = remove
  state.hidden = hidden
  state.token += 1
  const token = state.token
  if (state.timer) clearTimeout(state.timer)
  state.timer = null
  const presentClass = `${className}-present`
  const closingClass = `${className}-closing`
  node.classList.add(className)

  if (visible) {
    if (hidden) node.hidden = false
    if (node.classList.contains(presentClass) && !node.classList.contains(closingClass)) return Promise.resolve()
    node.classList.remove(closingClass)
    node.classList.remove(presentClass)
    if (reducedMotionValue(reducedMotion)) {
      node.classList.add(presentClass)
      return Promise.resolve()
    }
    globalThis.requestAnimationFrame?.(() => {
      if (state.token === token && node.isConnected !== false) node.classList.add(presentClass)
    })
    return Promise.resolve()
  }

  node.classList.remove(presentClass)
  node.classList.add(closingClass)
  const finish = () => {
    if (state.token !== token) return
    state.timer = null
    node.classList.remove(className, presentClass, closingClass)
    if (remove) node.remove()
    else if (hidden) node.hidden = true
    onComplete?.()
  }
  if (immediate || reducedMotionValue(reducedMotion)) {
    finish()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    state.timer = setTimeout(() => { finish(); resolve() }, Math.max(0, duration))
  })
}

export function shouldDismiss(position, velocity, height) {
  // 0.99 的指数衰减投影；明显向上反拉时回到展开态。
  const projected = position + projectMomentum(velocity, .99)
  return velocity > -80 && position > 0 && projected > Math.min(180, height * .28)
}

export function attachSheetMotion(dialog, overlay, handle, onClose) {
  const mobile = window.matchMedia('(max-width: 559px)')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  // 移动端全屏面板只保留一段短的启动位移,主要由缩放完成「从按钮打开 App」的感觉。
  const distance = () => mobile.matches ? Math.min(96, Math.max(48, dialog.offsetHeight * .1)) : 24
  const response = () => mobile.matches ? .38 : .34
  let position = reduced.matches ? 0 : distance()
  let velocity = 0
  let pointer = null
  let disposed = false

  function render() {
    dialog.style.transform = reduced.matches ? 'none' : `translateY(${position}px)`
    const progress = Math.min(1, Math.max(0, position / distance()))
    const scale = mobile.matches ? .94 + .06 * (1 - progress) : 1
    dialog.style.scale = reduced.matches ? '1' : String(scale)
    // 大面板只渐变遮罩，小弹窗同时淡入；移动端全屏面板再同步缩放，输入区始终保持清晰。
    dialog.style.opacity = mobile.matches ? '1' : String(1 - progress)
    overlay.style.backgroundColor = `rgba(22, 22, 28, ${.3 * (1 - progress)})`
  }
  const spring = createSpringController({
    value: position,
    target: 0,
    response: response(),
    reducedMotion: () => reduced.matches,
    onUpdate(nextPosition, nextVelocity, nextTarget) {
      if (disposed) return
      position = nextPosition
      velocity = nextVelocity
      render()
    },
    onRest(nextTarget) {
      if (nextTarget > 0 && !disposed) onClose()
    },
  })
  function animate(next, nextVelocity = null) {
    if (disposed) return
    spring.retarget(next, nextVelocity)
  }
  function close() {
    pointer = null
    animate(distance())
  }
  const samples = []
  function sample(event) {
    samples.push({ y: event.clientY, time: event.timeStamp })
    while (samples.length > 1 && event.timeStamp - samples[0].time > 100) samples.shift()
  }
  function down(event) {
    if (!mobile.matches || pointer || !event.isPrimary || event.button !== 0) return
    event.preventDefault()
    spring.stop()
    position = spring.getValue()
    velocity = spring.getVelocity()
    pointer = { id: event.pointerId, y: event.clientY, position, moved: false }
    samples.length = 0
    sample(event)
    try { handle.setPointerCapture(event.pointerId) } catch {}
  }
  function move(event) {
    if (pointer?.id !== event.pointerId) return
    const delta = event.clientY - pointer.y
    pointer.moved ||= Math.abs(delta) > 8
    const next = pointer.position + delta
    // 向上到边界后逐渐增加阻力，抓取位置始终相对当前画面。
    position = next >= 0 ? next : next * 80 / (80 + Math.abs(next))
    sample(event)
    render()
  }
  function end(event) {
    if (pointer?.id !== event.pointerId) return
    if (event.type !== 'pointerup') {
      pointer = null
      velocity = 0
      animate(0)
      return
    }
    const moved = pointer.moved
    sample(event)
    const elapsed = event.timeStamp - samples[0].time
    velocity = elapsed > 0 ? Math.max(-3000, Math.min(3000, (event.clientY - samples[0].y) / elapsed * 1000)) : 0
    pointer = null
    try { handle.releasePointerCapture(event.pointerId) } catch {}
    if (!moved || shouldDismiss(position, velocity, dialog.offsetHeight)) animate(distance(), velocity)
    else animate(0, velocity)
  }
  function resized() {
    if (spring.getTarget() > 0) { onClose(); return }
    pointer = null
    position = velocity = 0
    spring.set(0, 0)
    render()
  }
  function keyboardClick(event) { if (event.detail === 0) close() }
  handle.addEventListener('pointerdown', down)
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
  handle.addEventListener('lostpointercapture', end)
  handle.addEventListener('click', keyboardClick)
  window.addEventListener('resize', resized)
  render()
  animate(0)
  return {
    close,
    dispose() {
      disposed = true
      spring.dispose()
      window.removeEventListener('resize', resized)
      handle.removeEventListener('pointerdown', down)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      handle.removeEventListener('lostpointercapture', end)
      handle.removeEventListener('click', keyboardClick)
    },
  }
}
