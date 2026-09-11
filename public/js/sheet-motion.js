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

export function shouldDismiss(position, velocity, height) {
  // 0.99 的指数衰减投影；明显向上反拉时回到展开态。
  const projected = position + (velocity / 1000) * .99 / (1 - .99)
  return velocity > -80 && position > 0 && projected > Math.min(180, height * .28)
}

export function attachSheetMotion(dialog, overlay, handle, onClose) {
  const mobile = window.matchMedia('(max-width: 559px)')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  // 移动端全屏面板只保留一段短的启动位移,主要由缩放完成「从按钮打开 App」的感觉。
  const distance = () => mobile.matches ? Math.min(120, Math.max(64, dialog.offsetHeight * .12)) : 24
  let position = reduced.matches ? 0 : distance()
  let velocity = 0
  let target = 0
  let frame = 0
  let previousTime = 0
  let pointer = null
  let disposed = false

  function render() {
    dialog.style.transform = reduced.matches ? 'none' : `translateY(${position}px)`
    const progress = Math.min(1, Math.max(0, position / distance()))
    const scale = mobile.matches ? .92 + .08 * (1 - progress) : 1
    dialog.style.scale = reduced.matches ? '1' : String(scale)
    // 大面板只渐变遮罩，小弹窗同时淡入；移动端全屏面板再同步缩放，输入区始终保持清晰。
    dialog.style.opacity = mobile.matches ? '1' : String(1 - progress)
    overlay.style.backgroundColor = `rgba(22, 22, 28, ${.3 * (1 - progress)})`
  }
  function tick(time) {
    frame = 0
    if (disposed) return
    if (reduced.matches) {
      position = target
      velocity = 0
    } else {
      const next = stepSpring(position, velocity, target, Math.min((time - previousTime) / 1000, .05))
      position = next.position
      velocity = next.velocity
    }
    previousTime = time
    if (Math.abs(position - target) < .25 && Math.abs(velocity) < 4) {
      position = target
      velocity = 0
      render()
      if (target > 0) onClose()
      return
    }
    render()
    frame = requestAnimationFrame(tick)
  }
  function animate(next) {
    target = next
    if (frame || disposed) return
    previousTime = performance.now()
    frame = requestAnimationFrame(tick)
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
    cancelAnimationFrame(frame)
    frame = 0
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
    if (event.type === 'pointerup' && (!moved || shouldDismiss(position, velocity, dialog.offsetHeight))) close()
    else animate(0)
  }
  function resized() {
    if (target > 0) { onClose(); return }
    pointer = null
    position = velocity = 0
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
      cancelAnimationFrame(frame)
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
