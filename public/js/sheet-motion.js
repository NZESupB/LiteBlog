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
  let stiffness = Number(response) > 0 ? Number(response) : .34
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
    // 上限放宽到 200ms:弹簧是解析解,大 dt 也稳;卡到 50ms 会让掉帧的设备把动画整体拉长
    // (真机上就是「明明设了 0.3s 却慢慢收」)。只有后台回来这种超长间隔才夹一下。
    const seconds = previousTime ? Math.min(.2, Math.max(0, (time - previousTime) / 1000)) : 0
    previousTime = time
    const next = stepSpring(position, velocity, destination, seconds, stiffness)
    position = next.position
    velocity = next.velocity
    notify()
    // 残差与速度都足够小就落定。变形层的位移误差会被换算成不到 1px 的几何差,肉眼不可见,
    // 但阈值咬太紧会让最后一段「慢慢爬」的尾巴拖住收尾(手机上是可感知的延迟)。
    if (Math.abs(position - destination) < .5 && Math.abs(velocity) < 12) {
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
  // 布局重排(键盘、旋屏)专用:换目标或按比例挪位置时**不重置帧与 previousTime**。
  // 走 set()+retarget() 会取消当前帧再重排时间基准,键盘一次升降能触发十几次 resize,
  // 攒起来就是动画中途「卡住一下」——那一下正好停在粉色表面,看起来像闪了个红框。
  const adjust = (nextPosition, nextTarget) => {
    position = Number(nextPosition) || 0
    destination = Number(nextTarget) || 0
    resting = false
    if (!frame && !disposed) schedule()
  }
  notify()
  return {
    retarget,
    stop,
    set,
    adjust,
    // 展开与收起可以给不同节奏:换 response 只影响后续帧,当前位移与速度不变。
    setResponse(next) { if (Number(next) > 0) stiffness = Number(next) },
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
    if (hidden) {
      node.hidden = false
      // 从 hidden 里出来先强制一次样式计算:否则浏览器可能把「显示」与「加 present 类」
      // 合并成一次样式变更,于是 opacity / transform / max-width 的过渡被整段跳过,
      // 表现就是菜单或顶栏按钮「啪」地出现而不是淡入(桌面端顶栏写入口就踩过这条)。
      void node.offsetWidth
    }
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

const clamp01 = (value) => value < 0 ? 0 : value > 1 ? 1 : value
const lerp = (from, to, ratio) => from + (to - from) * ratio
function lengthPx(value) { const number = Number.parseFloat(value); return Number.isFinite(number) ? number : 0 }

export function attachSheetMotion(dialog, overlay, handle, onClose, { origin = null } = {}) {
  const mobile = window.matchMedia('(max-width: 559px)')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

  // ---------- 容器变形(液态展开) ----------
  // 面板从触发元素的位置长出来、关闭时收回同一处,桌面与移动端同一条路径。尺寸、圆角与
  // 材质全部由一块没有子节点的圆角矩形承担,面板本体不缩放、内容按进度淡入:文字不会被
  // 非等比拉伸,面板事后随内容改高也不会跟变形层错位 —— 静止时表面交还给面板本体。
  const originNode = origin?.isConnected ? origin : null
  const morph = originNode ? document.createElement('div') : null
  const base = { left: 0, top: 0 }
  let restRect = null
  let originRect = null
  let restRadius = [0, 0, 0, 0]
  let morphActive = false
  let triggerFill = null
  if (morph) {
    morph.className = 'composer-morph'
    morph.setAttribute('aria-hidden', 'true')
    // 触发元素自己的底色:起点必须和它一模一样(那一刻它就压在触发元素上)。
    const fill = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)$/.exec(getComputedStyle(originNode).backgroundColor || '')
    if (fill && (fill[4] === undefined || Number(fill[4]) > 0)) triggerFill = fill.slice(1, 4).map(Number)
    morph.style.background = triggerFill ? `rgb(${triggerFill.join(', ')})` : 'var(--accent)'
    // 先收起来:减少动态时不会有人把它摆出来,留在原地会是个没尺寸的色块。
    morph.style.display = 'none'
    overlay.appendChild(morph)
  }
  // 收起目标位移:变形路径拿它当进度量程(拖拽要有行程,所以按面板高度取),回退路径才是真的位移。
  const distance = () => morph
    ? Math.min(320, Math.max(120, dialog.offsetHeight * .3))
    : mobile.matches ? Math.min(96, Math.max(48, dialog.offsetHeight * .1)) : 24
  // 变形路径展开与收起同速(用户要求一致,收起那档的手感已确认);没有触发元素的回退路径沿用原来的节奏。
  const response = (closing) => morph ? .3 : mobile.matches ? .38 : .34
  let position = reduced.matches ? 0 : distance()
  let velocity = 0
  let pointer = null
  let disposed = false
  // 变形层绝对定位在遮罩层里:遮罩带 backdrop-filter,可能是 fixed 后代的包含块,
  // 因此几何统一换算成相对遮罩层左上角的坐标,视觉视口偏移时也不会错位。
  function relative(rect) {
    return { left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height }
  }
  function measure() {
    const overlayRect = overlay.getBoundingClientRect()
    base.left = overlayRect.left
    base.top = overlayRect.top
    const dialogRect = dialog.getBoundingClientRect()
    if (dialogRect.width && dialogRect.height) restRect = relative(dialogRect)
    if (originNode.isConnected) originRect = relative(originNode.getBoundingClientRect())
    const style = getComputedStyle(dialog)
    restRadius = [
      style.borderTopLeftRadius, style.borderTopRightRadius,
      style.borderBottomRightRadius, style.borderBottomLeftRadius,
    ].map(lengthPx)
  }
  function setMorphActive(active) {
    if (!morph || morphActive === active) return
    morphActive = active
    if (active) measure()
    overlay.classList.toggle('morph', active)
    morph.style.display = active ? '' : 'none'
    if (!active) originNode.classList.remove('composer-origin-hidden')
  }
  function renderMorph(progress) {
    if (!restRect || !originRect) return
    const ratio = clamp01(progress)
    // 收到触发元素时四角收成胶囊,展开途中再各自回到面板原本的圆角。
    const pill = Math.min(originRect.width, originRect.height) / 2
    morph.style.left = `${lerp(restRect.left, originRect.left, ratio)}px`
    morph.style.top = `${lerp(restRect.top, originRect.top, ratio)}px`
    morph.style.width = `${lerp(restRect.width, originRect.width, ratio)}px`
    morph.style.height = `${lerp(restRect.height, originRect.height, ratio)}px`
    morph.style.borderRadius = restRadius.map((radius) => `${lerp(radius, pill, ratio)}px`).join(' ')
    // 材质分三段:触发元素的实色 → 透明液态玻璃(滑行时一路能看见底下的内容)→ 最后一段
    // 才凝成纸面;内容再晚一步跟上。收回时顺序正好相反,所以缩回去也是玻璃质感。
    // 强调色早点让位给玻璃:开头那段粉色别再拖那么久(收起时顺序反过来,照样收成粉色胶囊)
    const glassIn = clamp01((.95 - ratio) / .35)
    const paper = clamp01((.2 - ratio) / .16)
    const content = clamp01((.18 - ratio) / .14)
    morph.style.setProperty('--morph-glass-opacity', String(glassIn * (1 - paper)))
    morph.style.setProperty('--morph-paper', String(paper))
    if (triggerFill) morph.style.background = `rgba(${triggerFill[0]}, ${triggerFill[1]}, ${triggerFill[2]}, ${(1 - glassIn).toFixed(3)})`
    overlay.style.setProperty('--morph-content', String(content))
    // 内容比表面晚一步:入场时从下方 12px 升上来,收起/拖动时跟着位移下沉(限幅,免得甩出去)。
    overlay.style.setProperty('--morph-shift', `${(1 - content) * 12 + Math.min(position * .6, 96)}px`)
    originNode.classList.toggle('composer-origin-hidden', ratio > .04)
  }

  function render() {
    const progress = clamp01(position / Math.max(1, distance()))
    if (morph) {
      setMorphActive(progress > .002)
      if (morphActive) renderMorph(progress)
      overlay.style.backgroundColor = `rgba(22, 22, 28, ${.3 * (1 - progress)})`
      return
    }
    dialog.style.transform = reduced.matches ? 'none' : `translateY(${position}px)`
    const scale = mobile.matches ? .94 + .06 * (1 - progress) : 1
    dialog.style.scale = reduced.matches ? '1' : String(scale)
    // 大面板只渐变遮罩，小弹窗同时淡入；移动端全屏面板再同步缩放，输入区始终保持清晰。
    dialog.style.opacity = mobile.matches ? '1' : String(1 - progress)
    overlay.style.backgroundColor = `rgba(22, 22, 28, ${.3 * (1 - progress)})`
  }
  const spring = createSpringController({
    value: position,
    target: 0,
    response: response(false),
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
    settle(distance())
  }
  // 收起统一走 settle():先按收起挡位设好 response 再定目标,避免第一帧还用着上一段的节奏。
  function settle(target, nextVelocity = null) {
    spring.setResponse(response(true))
    animate(target, nextVelocity)
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
    if (!moved || shouldDismiss(position, velocity, dialog.offsetHeight)) settle(distance(), velocity)
    else animate(0, velocity)
  }
  // 键盘弹出/收起、旋屏都会改面板与触发元素的几何。这里只重新量一遍再把动画接回去:
  // 直接跳到终点会吃掉入场动画,直接收尾会让「输入法起来时点 × 」没有收回动画。
  let resizedFrame = 0
  function resized() {
    pointer = null
    if (!morph) {
      if (spring.getTarget() > 0) { onClose(); return }
      position = velocity = 0
      spring.set(0, 0)
      render()
      return
    }
    // 视口尺寸是下一帧才写进 CSS 变量的(attachComposerViewport 自己排了一帧),
    // 所以这里也等一帧再量:既量到重排后的几何,又把输入法一次升降里的十几个 resize 合成一次。
    if (resizedFrame) return
    resizedFrame = globalThis.requestAnimationFrame(() => {
      resizedFrame = 0
      if (disposed) return
      const closing = spring.getTarget() > 0
      const ratio = clamp01(position / Math.max(1, distance()))
      measure()
      // 只按新几何换算进度与目标,当前的位移、速度与动画帧都原样接着走
      spring.adjust(ratio * distance(), closing ? distance() : 0)
    })
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
      if (resizedFrame) globalThis.cancelAnimationFrame(resizedFrame)
      resizedFrame = 0
      spring.dispose()
      originNode?.classList.remove('composer-origin-hidden')
      if (morph) overlay.classList.remove('morph')
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
