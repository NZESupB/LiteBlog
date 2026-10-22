// 每次页面替换都产生新的 scope；旧响应即使已到达，也不能提交到新页面。
export function createViewScope() {
  const controller = new AbortController()
  const cleanups = new Set()
  return {
    signal: controller.signal,
    alive: () => !controller.signal.aborted,
    own(cleanup) {
      if (controller.signal.aborted) cleanup()
      else cleanups.add(cleanup)
      return cleanup
    },
    disown(cleanup) { cleanups.delete(cleanup) },
    timeout(callback, milliseconds) {
      const timer = setTimeout(() => { cleanups.delete(cancel); if (!controller.signal.aborted) callback() }, milliseconds)
      const cancel = () => clearTimeout(timer)
      cleanups.add(cancel)
      return cancel
    },
    dispose() {
      if (controller.signal.aborted) return
      controller.abort()
      try { for (const cleanup of cleanups) cleanup() }
      finally { cleanups.clear() }
    },
  }
}
