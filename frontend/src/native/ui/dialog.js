import { disposeAnimations } from './motion.js'

// 原生 top layer 负责模态隔离和 Tab 边界；所有组件共用滚动锁与焦点归还。
const opened = new Set()
let savedScroll = 0
export function createDialog(node, { remove = false, closeOnBackdrop = true, onRequestClose = () => {}, onClosed = () => {} } = {}) {
  let trigger = null
  let active = false
  node.classList.add('app-dialog')
  const requestClose = (event) => {
    // 文件 input 的 cancel 会冒泡，不能作为外层模态的关闭请求。
    if (event.target !== node) return
    event.preventDefault()
    if (active) onRequestClose()
  }
  const backdrop = (event) => { if (closeOnBackdrop && event.target === node) requestClose(event) }
  node.addEventListener('cancel', requestClose)
  node.addEventListener('click', backdrop)
  const finish = ({ restoreFocus = true } = {}) => {
    if (!active) return
    active = false
    disposeAnimations(node)
    node.inert = false
    node.close()
    node.hidden = true
    opened.delete(node)
    if (!opened.size) {
      document.body.classList.remove('modal-open')
      window.scrollTo({ top: savedScroll, behavior: 'instant' })
    }
    if (remove) node.remove()
    if (restoreFocus && trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true })
    trigger = null
    onClosed()
  }
  return {
    node,
    open({ source = document.activeElement, focus } = {}) {
      if (active) { node.inert = false; return }
      trigger = source
      active = true
      if (!opened.size) savedScroll = window.scrollY
      opened.add(node)
      document.body.classList.add('modal-open')
      if (!node.isConnected) document.body.appendChild(node)
      node.hidden = false
      node.inert = false
      node.showModal()
      ;(focus || node.querySelector('button, input, textarea, [tabindex]'))?.focus({ preventScroll: true })
    },
    beginClose() { node.inert = true },
    finish,
    dispose(options) {
      finish(options)
      node.removeEventListener('cancel', requestClose)
      node.removeEventListener('click', backdrop)
    },
  }
}
