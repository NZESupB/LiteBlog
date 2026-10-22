// 构建时写入内容哈希与完整资源清单；源码本身不作为生产 SW 使用。
const CACHE_NAME = /* BUILD_CACHE */ 'couple-blog-shell-development'
const SHELL = /* BUILD_SHELL */ []
const PREFIX = 'couple-blog-shell-'
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))))
})
self.addEventListener('message', (event) => { if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting() })
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== CACHE_NAME)
    // 多标签页可能还在使用更早的脚本；只在单标签页时回收到上一版。
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.length <= 1) await Promise.all(names.slice(0, -1).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})
self.addEventListener('fetch', (event) => {
  const { request } = event, url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^\/(?:api|uploads|avatars)(?:\/|$)/.test(url.pathname)) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE_NAME)).match('/index.html')))
    return
  }
  if (!SHELL.includes(url.pathname) && !/^\/(?:assets|js|vendor)\//.test(url.pathname) && url.pathname !== '/app.js') return
  event.respondWith((async () => {
    const oldResource = !SHELL.includes(url.pathname)
    if (url.pathname.startsWith('/assets/') || oldResource) {
      const cached = await caches.match(request)
      if (cached) return cached
    }
    try {
      const response = await fetch(request)
      if (response.ok) return response
      return await caches.match(request) || response
    } catch {
      return await caches.match(request) || Response.error()
    }
  })())
})
self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data?.json() || {} } catch { payload = { body: event.data?.text() || '' } }
  event.waitUntil(self.registration.showNotification(payload.title || '新的评论', { body: payload.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: payload.tag || `comment-${payload.commentId || ''}`, data: { postId: payload.postId, commentId: payload.commentId } }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { postId, commentId } = event.notification.data || {}, hash = postId ? `#/post/${postId}${commentId ? `?comment=${commentId}` : ''}` : '#/'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const target = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (target) { await target.navigate('/' + hash); await target.focus() }
    else await self.clients.openWindow('/' + hash)
  })())
})
