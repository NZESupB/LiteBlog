// 无框架的界面回归：主题恢复与容错、配色对比度、面板手势和弹簧中断。
// 执行：node tests/interface-regression.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { stepSpring, shouldDismiss, attachSheetMotion } from '../public/js/sheet-motion.js'

const source = readFileSync(new URL('../public/js/theme.js', import.meta.url), 'utf8')
function themeEnvironment(stored, blocked = false) {
  const events = new EventTarget()
  const root = { dataset: {} }
  const meta = {}
  const storage = new Map([['journal-theme', stored]])
  const context = {
    window: events, Event,
    document: { documentElement: root, querySelector: () => meta },
    localStorage: {
      getItem: (key) => { if (blocked) throw Error('存储不可用'); return storage.get(key) },
      setItem: (key, value) => { if (blocked) throw Error('存储不可用'); storage.set(key, value) },
    },
  }
  vm.runInNewContext(source, context)
  return { theme: events.JournalTheme, storage, root, meta, events }
}
for (const stored of [undefined, '', 'unknown', '<script>']) {
  assert.equal(themeEnvironment(stored).theme.current, 'pink')
}
for (const id of ['pink', 'blue', 'cream']) {
  const environment = themeEnvironment(id)
  assert.equal(environment.theme.current, id)
  assert.equal(environment.theme.set(id), true)
  assert.equal(environment.storage.get('journal-theme'), id)
  assert.equal(environment.meta.content, environment.theme.choices.find((choice) => choice.id === id).color)
}
const blocked = themeEnvironment('blue', true)
assert.equal(blocked.theme.current, 'pink')
assert.equal(blocked.theme.set('cream'), false)
assert.equal(blocked.theme.current, 'cream')
const synced = themeEnvironment('pink')
synced.events.dispatchEvent(Object.assign(new Event('storage'), { key: 'journal-theme', newValue: 'blue' }))
assert.equal(synced.theme.current, 'blue')
synced.events.dispatchEvent(Object.assign(new Event('storage'), { key: null, newValue: null }))
assert.equal(synced.theme.current, 'pink')

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
function tokens(block) {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[a-f0-9]{6})/g)].map((match) => [match[1], match[2]]))
}
function luminance(hex) {
  return hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a)
  return (values[0] + .05) / (values[1] + .05)
}
const defaults = tokens(css.match(/:root \{([^}]+)\}/)[1])
for (const id of ['pink', 'blue', 'cream']) {
  const colors = { ...defaults, ...tokens(css.match(new RegExp(`\\[data-theme="${id}"\\] \\{([^}]+)\\}`))?.[1] || '') }
  for (const foreground of ['--ink', '--text', '--muted', '--faint']) {
    for (const background of ['--bg', '--card', '--accent-soft']) {
      assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${id} ${foreground}/${background}`)
    }
  }
  for (const button of ['--accent', '--accent-deep']) assert.ok(contrast('#ffffff', colors[button]) >= 4.5, `${id} ${button}`)
}

let spring = { position: 300, velocity: 0 }
for (let i = 0; i < 120; i++) spring = stepSpring(spring.position, spring.velocity, 0, 1 / 60)
assert.ok(Math.abs(spring.position) < .001)
assert.ok(Math.abs(spring.velocity) < .001)
const interrupted = stepSpring(100, 400, 0, .001)
assert.ok(interrupted.position > 100, '反向目标先继承原速度，不能瞬间反跳')
assert.equal(shouldDismiss(40, 1400, 500), true, '短距离快速下甩可以收起')
assert.equal(shouldDismiss(140, -300, 500), false, '向上反拉取消收起')
assert.equal(shouldDismiss(40, 0, 500), false, '短距离慢拖回位')

const original = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, performance: globalThis.performance }
let time = 0
let nextFrame = 0
let reduced = false
const frames = new Map()
const fakeWindow = new EventTarget()
fakeWindow.matchMedia = (query) => ({ get matches() { return query.includes('reduced-motion') ? reduced : true } })
globalThis.window = fakeWindow
globalThis.performance = { now: () => time }
globalThis.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id }
globalThis.cancelAnimationFrame = (id) => frames.delete(id)
function advance(count = 90) {
  for (let i = 0; i < count; i++) {
    time += 1000 / 60
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback(time))
  }
}
function panel() {
  const handle = new EventTarget()
  handle.setPointerCapture = () => {}
  handle.releasePointerCapture = () => {}
  const dialog = { offsetHeight: 500, style: {} }
  const overlay = { style: {} }
  let closed = false
  const motion = attachSheetMotion(dialog, overlay, handle, () => { closed = true; motion.dispose() })
  const send = (type, y) => {
    const event = Object.assign(new Event(type), { clientY: y, pointerId: 1, isPrimary: true, button: 0 })
    Object.defineProperty(event, 'timeStamp', { value: time })
    return handle.dispatchEvent(event)
  }
  return { motion, dialog, send, get closed() { return closed } }
}
try {
  const first = panel()
  advance()
  first.send('pointerdown', 200)
  time += 50
  first.send('pointermove', 420)
  first.send('pointercancel', 420)
  advance()
  assert.equal(first.closed, false, '系统取消手势不能关闭写作面板')
  assert.equal(first.dialog.style.transform, 'translateY(0px)')
  assert.equal(first.dialog.style.scale, '1', '面板打开后缩放回到原始尺寸')
  first.motion.close()
  advance(3)
  const position = parseFloat(first.dialog.style.transform.slice(11))
  first.send('pointerdown', 400)
  assert.equal(parseFloat(first.dialog.style.transform.slice(11)), position, '抓住关闭中的面板时不跳动')
  time += 30
  first.send('pointermove', 250)
  first.send('pointerup', 250)
  advance()
  assert.equal(first.closed, false, '关闭途中可反拉打开')
  first.motion.close()
  advance()
  assert.equal(first.closed, true)
  reduced = true
  const second = panel()
  advance(1)
  assert.equal(second.dialog.style.transform, 'none')
  assert.equal(second.dialog.style.scale, '1')
  second.motion.close()
  advance(1)
  assert.equal(second.closed, true, '减少动态立即结束位移')
  assert.equal(frames.size, 0, '关闭后清理动画帧')
} finally {
  Object.assign(globalThis, original)
}
console.log('通过：三种主题恢复、存储容错、跨页同步、文本对比度、弹簧连续性、取消手势、反向中断与减少动态。')
