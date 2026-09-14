// 无框架的界面回归：外观(跟随系统/浅色/深色)恢复与容错、明暗配色对比度、面板手势和弹簧中断。
// 执行：node tests/interface-regression.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { stepSpring, shouldDismiss, attachSheetMotion, projectMomentum, createSpringController, animatePresence } from '../public/js/sheet-motion.js'

const source = readFileSync(new URL('../public/js/theme.js', import.meta.url), 'utf8')
// system 档由系统偏好决定,这里用可控的 matchMedia 模拟深色系统
function themeEnvironment(stored, blocked = false, systemDark = false) {
  const events = new EventTarget()
  events.matchMedia = (query) => ({
    get matches() { return systemDark && query.includes('prefers-color-scheme: dark') },
    addEventListener() {},
  })
  const root = { dataset: {} }
  const meta = { content: '' }
  const storage = new Map([['journal-theme', stored]])
  const context = {
    window: events, Event, EventTarget,
    document: { documentElement: root, querySelector: () => ({ setAttribute: (_key, value) => { meta.content = value } }) },
    localStorage: {
      getItem: (key) => { if (blocked) throw Error('存储不可用'); return storage.get(key) },
      setItem: (key, value) => { if (blocked) throw Error('存储不可用'); storage.set(key, value) },
    },
  }
  vm.runInNewContext(source, context)
  return { theme: events.JournalTheme, storage, root, meta, events }
}
// 旧版存的是 pink/blue/cream,配色收敛后一律回落成「跟随系统」
for (const stored of [undefined, '', 'unknown', '<script>', 'pink', 'blue', 'cream']) {
  const environment = themeEnvironment(stored)
  assert.equal(environment.theme.preference, 'system', String(stored))
  assert.equal(environment.theme.current, 'light', String(stored))
}
const systemDark = themeEnvironment(undefined, false, true)
assert.equal(systemDark.theme.current, 'dark', '跟随系统时要解析成深色')
assert.equal(systemDark.meta.content, '#000000', '浏览器界面色要跟着深浅切换')
for (const [id, expected] of [['light', 'light'], ['dark', 'dark'], ['system', 'light']]) {
  const environment = themeEnvironment('light')
  assert.equal(environment.theme.set(id), true)
  assert.equal(environment.theme.preference, id)
  assert.equal(environment.theme.current, expected)
  assert.equal(environment.storage.get('journal-theme'), id)
}
const blocked = themeEnvironment('light', true)
assert.equal(blocked.theme.preference, 'system', '读不到本机存储时回落为跟随系统')
assert.equal(blocked.theme.set('dark'), false, '存储不可用时要如实返回 false')
assert.equal(blocked.theme.current, 'dark', '存不下也要立刻生效')
const synced = themeEnvironment('light')
synced.events.dispatchEvent(Object.assign(new Event('storage'), { key: 'journal-theme', newValue: 'dark' }))
assert.equal(synced.theme.current, 'dark')
synced.events.dispatchEvent(Object.assign(new Event('storage'), { key: null, newValue: null }))
assert.equal(synced.theme.current, 'light')

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
assert.match(css, /--motion-standard-duration/)
assert.match(css, /\.menu-presence-closing/)
assert.match(css, /\.page-enter/)
assert.doesNotMatch(css, /@keyframes pop/)
assert.match(css, /\.comment-reply-state\[hidden\] \{ display: none; \}/)
assert.match(css, /\.comment-form\[hidden\] \{ display: none; \}/)
assert.match(css, /@keyframes day-progress-sheen/)
assert.match(css, /\.day-progress-fill \{[\s\S]*?transform: scaleX\(var\(--day-progress\)\)/)
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
const light = tokens(css.match(/:root \{([^}]+)\}/)[1])
const dark = { ...light, ...tokens(css.match(/\[data-theme="dark"\] \{([^}]+)\}/)[1]) }
for (const [scheme, colors, onAccent] of [['light', light, '#ffffff'], ['dark', dark, '#2a0d18']]) {
  for (const foreground of ['--ink', '--text', '--muted', '--faint']) {
    for (const background of ['--bg', '--surface']) {
      assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${scheme} ${foreground}/${background}`)
    }
  }
  // 强调色在浅色底上既要能当按钮底(白字),也要能当文字色
  assert.ok(contrast(onAccent, colors['--accent']) >= 4.5, `${scheme} 按钮文字`)
  assert.ok(contrast(colors['--accent-deep'], colors['--bg']) >= 4.5, `${scheme} 强调文字/底`)
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
assert.ok(Math.abs(projectMomentum(1000, .99) - 99) < .001)
assert.equal(projectMomentum(0), 0)

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
function presenceNode() {
  const names = new Set()
  return {
    hidden: true,
    isConnected: true,
    removed: false,
    classList: {
      add: (...values) => values.forEach((value) => names.add(value)),
      remove: (...values) => values.forEach((value) => names.delete(value)),
      contains: (value) => names.has(value),
    },
    remove() { this.removed = true; this.isConnected = false },
    hasClass(value) { return names.has(value) },
  }
}
try {
  const controllerUpdates = []
  const controllerRests = []
  const controller = createSpringController({
    value: 0,
    response: .34,
    reducedMotion: () => reduced,
    onUpdate: (position, velocity, target) => controllerUpdates.push({ position, velocity, target }),
    onRest: (target) => controllerRests.push(target),
  })
  controller.retarget(120)
  advance(8)
  const interruptedPosition = controller.getValue()
  controller.retarget(-36)
  assert.ok(controller.getValue() >= interruptedPosition - .001, '重定向从当前 presentation value 继续')
  advance(120)
  assert.ok(Math.abs(controller.getValue() + 36) < .001, '重定向最终到达新目标')
  assert.ok(controllerRests.includes(-36), '重定向完成回调只在目标稳定后触发')
  assert.ok(controllerUpdates.some((update) => update.target === 120), '控制器持续报告目标与速度')
  controller.dispose()

  const presence = presenceNode()
  animatePresence(presence, true, { className: 'test-presence', duration: 20 })
  advance(1)
  assert.equal(presence.hidden, false)
  assert.equal(presence.hasClass('test-presence-present'), true)
  const closePresence = animatePresence(presence, false, { className: 'test-presence', duration: 1, remove: true })
  assert.equal(presence.removed, false, '退出动画完成前保留节点')
  await closePresence
  assert.equal(presence.removed, true, '退出动画完成后移除节点')

  const interruptedPresence = presenceNode()
  animatePresence(interruptedPresence, true, { className: 'test-presence', duration: 20 })
  advance(1)
  animatePresence(interruptedPresence, false, { className: 'test-presence', duration: 50, remove: true })
  animatePresence(interruptedPresence, true, { className: 'test-presence', duration: 20 })
  advance(1)
  assert.equal(interruptedPresence.removed, false, '重新打开会取消上一段退出')
  assert.equal(interruptedPresence.hasClass('test-presence-present'), true)

  reduced = true
  const reducedPresence = presenceNode()
  animatePresence(reducedPresence, true, { className: 'test-presence', reducedMotion: () => reduced })
  assert.equal(reducedPresence.hasClass('test-presence-present'), true)
  animatePresence(reducedPresence, false, { className: 'test-presence', reducedMotion: () => reduced, remove: true })
  assert.equal(reducedPresence.removed, true, '减少动态立即完成 presence 清理')
  reduced = false

  const first = panel()
  assert.ok(Number(first.dialog.style.scale) < 1, '面板入场从缩放状态开始')
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
console.log('通过：外观三档恢复、旧值回落、跨页同步、明暗对比度、弹簧连续性、取消手势、反向中断与减少动态。')
