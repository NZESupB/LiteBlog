// 执行：node tests/composer-viewport-regression.mjs。模拟键盘只改变 VisualViewport 的手机行为。
import assert from 'node:assert/strict'
import { attachComposerViewport } from '../public/js/composer-viewport.js'

const originals = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
const frames = new Map()
let frameId = 0
const win = new EventTarget()
const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 })
win.innerHeight = 844
win.visualViewport = viewport
const classes = new Map()
const styles = new Map()
let inputBounds = { top: 400, bottom: 580 }
let bodyBounds = { top: 100, bottom: 700 }
const input = { matches: () => true, getBoundingClientRect: () => inputBounds }
const scroller = { scrollTop: 0, contains: (node) => node === input, getBoundingClientRect: () => bodyBounds }
const overlay = Object.assign(new EventTarget(), {
  querySelector: () => scroller,
  style: { setProperty: (key, value) => styles.set(key, value) },
  classList: { toggle: (name, value) => classes.set(name, value) },
})
globalThis.window = win
globalThis.document = { activeElement: input }
globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId }
globalThis.cancelAnimationFrame = (id) => frames.delete(id)
function flush() {
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach((callback) => callback())
}
let dispose
try {
  dispose = attachComposerViewport(overlay)
  assert.equal(styles.get('--composer-viewport-height'), '844px')
  assert.equal(classes.get('keyboard-open'), false)
  // 布局视口不变，只有键盘上方的可见高度减少。
  viewport.height = 420
  bodyBounds = { top: 100, bottom: 420 }
  viewport.dispatchEvent(new Event('resize'))
  viewport.dispatchEvent(new Event('scroll'))
  assert.equal(frames.size, 1, '同帧合并键盘 resize/scroll')
  flush()
  assert.equal(styles.get('--composer-viewport-height'), '420px')
  assert.equal(classes.get('keyboard-open'), true)
  assert.equal(scroller.scrollTop, 168, '正文底部被遮挡时滚入可视区域')
  // iOS 自动平移后，用 offsetTop 更新面板，避免落在屏幕之外。
  viewport.offsetTop = 65
  viewport.dispatchEvent(new Event('scroll'))
  flush()
  assert.equal(styles.get('--composer-viewport-top'), '65px')
  inputBounds = { top: 70, bottom: 180 }
  scroller.scrollTop = 50
  overlay.dispatchEvent(new Event('focusin'))
  flush()
  assert.equal(scroller.scrollTop, 12, '上方被裁切的输入框也要滚回')
  viewport.height = 844
  viewport.offsetTop = 0
  viewport.dispatchEvent(new Event('resize'))
  flush()
  assert.equal(classes.get('keyboard-open'), false)
  assert.equal(styles.get('--composer-viewport-height'), '844px')
  viewport.scale = 2
  viewport.height = 422
  viewport.dispatchEvent(new Event('resize'))
  flush()
  assert.equal(classes.get('keyboard-open'), false, '双指缩放不应误判为输入法')
  viewport.dispatchEvent(new Event('resize'))
  dispose()
  assert.equal(frames.size, 0)
  for (const event of ['resize', 'scroll']) viewport.dispatchEvent(new Event(event))
  win.dispatchEvent(new Event('resize'))
  overlay.dispatchEvent(new Event('focusin'))
  assert.equal(frames.size, 0, '关闭后移除所有监听')
  // 不支持 VisualViewport，或 Android 直接缩小布局视口时，也能限高。
  delete win.visualViewport
  win.innerHeight = 360
  dispose = attachComposerViewport(overlay)
  assert.equal(styles.get('--composer-viewport-height'), '360px')
  assert.equal(classes.get('keyboard-open'), true)
  win.innerHeight = 844
  win.dispatchEvent(new Event('resize'))
  flush()
  assert.equal(classes.get('keyboard-open'), false)
  console.log('通过：键盘可视高度、iOS 平移、正文滚入、键盘收起、缩放区分、无 API 回退、监听清理。')
} finally {
  dispose?.()
  Object.assign(globalThis, originals)
}
