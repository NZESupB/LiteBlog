// 恢复时阻止新请求，等待已有请求和后台数据库回调结束；不依赖数据库模块。
let maintenance = false
const operations = new Map()
const waiters = new Set()

export function isMaintenance() { return maintenance }

export function enterOperation(kind = 'request') {
  if (maintenance) throw Object.assign(new Error('正在恢复数据库，请稍后重试'), { status: 503 })
  const token = Symbol(kind)
  operations.set(token, kind)
  let released = false
  const release = () => {
    if (released) return
    released = true
    operations.delete(token)
    for (const notify of waiters) notify()
  }
  release.token = token
  return release
}

export function hasMediaOperations() {
  return [...operations.values()].includes('media')
}

export async function beginMaintenance(timeoutMs = 10000, excludedToken = null) {
  if (maintenance) throw Object.assign(new Error('恢复操作已在进行'), { status: 409 })
  maintenance = true
  const pending = () => [...operations.keys()].some((token) => token !== excludedToken)
  if (!pending()) return
  await new Promise((resolve, reject) => {
    const done = () => {
      if (pending()) return
      clearTimeout(timer)
      waiters.delete(done)
      resolve()
    }
    const timer = setTimeout(() => {
      waiters.delete(done)
      reject(Object.assign(new Error('仍有请求或后台操作未结束，请稍后重试恢复'), { status: 409 }))
    }, timeoutMs)
    waiters.add(done)
    done()
  })
}

export function endMaintenance() { maintenance = false }

export async function maintenanceMiddleware(c, next) {
  if (maintenance) return c.json({ error: '正在恢复数据库，请稍后重试' }, 503, { 'Retry-After': '3' })
  const release = enterOperation()
  c.set('releaseDatabaseRequest', release)
  c.set('databaseOperationToken', release.token)
  try { await next() } finally { release() }
}
