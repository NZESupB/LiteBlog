import { animateElement, disposeAnimations, motionEasing, motionTiming } from './motion.js'

// 只有设置首页与其已知子页之间表达层级；直达与站外导航不补播。
export function settingsTransition(from, to) {
  const isSettings = (path) => /^#\/settings(?:\/(?:site|ai|storage|backup|profile))?$/.test(path)
  if (from === to || !isSettings(from) || !isSettings(to)) return 'none'
  if (from === '#/settings') return 'push'
  if (to === '#/settings') return 'pop'
  return 'replace'
}

export function enterSettingsView(node, scope, kind = 'none') {
  if (!scope.alive() || !node.isConnected) return Promise.resolve({ status: 'disposed' })
  const offset = kind === 'push' ? 16 : kind === 'pop' ? -16 : 0
  node.dataset.motionOwned = 'settings'
  const animation = animateElement(node, { opacity: 1, transform: 'translateX(0px)' }, {
    initial: { opacity: kind === 'none' ? 1 : 0, transform: `translateX(${offset}px)` },
    duration: kind === 'replace' ? motionTiming.content : motionTiming.settings,
    easing: motionEasing.out,
    immediate: kind === 'none',
  })
  scope.own(() => disposeAnimations(node))
  return animation.finished
}
