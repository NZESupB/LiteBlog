import { el, setFormMessage } from '../utils.js'
import { createDialog } from './dialog.js'
import { animatePresence } from './motion.js'

export function openAvatarCropper(file, onConfirm, onCancel, scope) {
  if (scope && !scope.alive()) return null
  const overlay = el(`<dialog class="avatar-crop-overlay" aria-label="裁剪头像"><div class="avatar-crop-dialog">
    <div class="avatar-crop-heading"><h2>调整头像</h2><button class="avatar-crop-close" type="button" aria-label="取消">×</button></div>
    <p class="avatar-crop-hint">拖动图片调整位置，使用滑块缩放</p>
    <div class="avatar-crop-stage"><canvas width="256" height="256"></canvas></div>
    <label class="avatar-zoom">缩放<input type="range" min="1" max="3" step="0.01" value="1" /></label>
    <p class="form-message" role="status"></p>
    <div class="avatar-crop-actions"><button class="btn-ghost avatar-crop-cancel" type="button">取消</button><button class="btn avatar-crop-confirm" type="button" disabled>使用此头像</button></div>
  </div></dialog>`)
  const find = (selector) => overlay.querySelector(selector)
  const canvas = find('canvas'), ctx = canvas.getContext('2d'), stage = find('.avatar-crop-stage')
  const confirm = find('.avatar-crop-confirm'), surface = find('.avatar-crop-dialog')
  const image = new Image(), url = URL.createObjectURL(file)
  let baseScale = 1, zoom = 1, offsetX = 0, offsetY = 0, drag = null, closed = false, closing = null, accepted = false
  const modal = createDialog(overlay, {
    remove: true,
    onRequestClose: () => finish(),
    onClosed() {
      closed = true
      image.onload = image.onerror = null
      image.removeAttribute('src')
      canvas.width = canvas.height = 0
      scope?.disown(disposeOnLeave)
      URL.revokeObjectURL(url)
      if (!accepted) onCancel?.()
    },
  })
  const draw = () => {
    if (closed || !image.naturalWidth) return
    const width = image.naturalWidth * baseScale * zoom, height = image.naturalHeight * baseScale * zoom
    offsetX = Math.max(128 - width / 2, Math.min(width / 2 - 128, offsetX))
    offsetY = Math.max(128 - height / 2, Math.min(height / 2 - 128, offsetY))
    ctx.clearRect(0, 0, 256, 256)
    ctx.fillStyle = getComputedStyle(overlay).getPropertyValue('--surface-2').trim()
    ctx.fillRect(0, 0, 256, 256)
    ctx.drawImage(image, 128 + offsetX - width / 2, 128 + offsetY - height / 2, width, height)
  }
  function finish() {
    if (closed) return Promise.resolve()
    if (closing) return closing
    modal.beginClose()
    drag = null
    closing = Promise.all([
      animatePresence(overlay, false, { className: 'overlay-presence', hidden: false }),
      animatePresence(surface, false, { className: 'dialog-presence', duration: 260, hidden: false }),
    ]).then(() => { if (!closed) modal.dispose() })
    return closing
  }
  image.onload = () => { baseScale = 256 / Math.min(image.naturalWidth, image.naturalHeight); confirm.disabled = false; draw() }
  image.onerror = () => { setFormMessage(find('.form-message'), '无法读取这张图片，请重新选择。') }
  image.src = url
  find('input').oninput = (event) => { zoom = Number(event.target.value) || 1; draw() }
  stage.onpointerdown = (event) => {
    if (!event.isPrimary || event.button !== 0 || drag) return
    event.preventDefault()
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX, offsetY }
    try { stage.setPointerCapture(event.pointerId) } catch {}
  }
  stage.onpointermove = (event) => {
    if (drag?.pointerId !== event.pointerId) return
    const ratio = canvas.width / Math.max(1, canvas.getBoundingClientRect().width)
    offsetX = drag.offsetX + (event.clientX - drag.x) * ratio
    offsetY = drag.offsetY + (event.clientY - drag.y) * ratio
    draw()
  }
  stage.onpointerup = stage.onpointercancel = stage.onlostpointercapture = () => { drag = null }
  find('.avatar-crop-close').onclick = find('.avatar-crop-cancel').onclick = () => { void finish() }
  confirm.onclick = async () => {
    confirm.disabled = true
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .9))
      if (closed || closing) return
      if (!blob) throw new Error('头像裁剪失败')
      const result = await onConfirm(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }))
      if (closed || closing) return
      if (result !== false) { accepted = true; await finish() }
      else confirm.disabled = false
    } catch (error) {
      if (!closed) { setFormMessage(find('.form-message'), error.message); confirm.disabled = false }
    }
  }
  const disposeOnLeave = () => modal.dispose({ restoreFocus: false })
  scope?.own(disposeOnLeave)
  modal.open({ focus: find('.avatar-crop-close') })
  animatePresence(overlay, true, { className: 'overlay-presence' })
  animatePresence(surface, true, { className: 'dialog-presence', duration: 260 })
  return { node: overlay, dispose: () => modal.dispose() }
}
