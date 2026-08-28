const CACHE_NAME = 'couple-blog-shell-v4'
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/vendor/marked.min.js',
  '/vendor/purify.min.js',
  '/vendor/md-toolbar.js',
  '/vendor/icons.js',
  '/js/utils.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || url.pathname === '/sw.js') return
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME)
        await cache.put('/index.html', response.clone())
      }
      return response
    }).catch(() => caches.match('/index.html')))
    return
  }
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()))
    return response
  }).catch(() => caches.match(event.request)))
})

// 服务端推来的新评论。userVisibleOnly 订阅必须弹通知,取不到载荷时也给个兜底文案。
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data?.json() ?? {} } catch {}
  event.waitUntil(self.registration.showNotification(data.title || '新评论', {
    body: data.body || '',
    tag: data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { postId: data.postId, commentId: data.commentId },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const target = `/#/post/${data.postId}?comment=${data.commentId}`
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const page of pages) {
      if (!('focus' in page)) continue
      try {
        const targetPage = await page.navigate(target)
        await (targetPage || page).focus()
        return
      } catch {
        await page.focus()
        page.postMessage({ type: 'notification-click', postId: data.postId, commentId: data.commentId })
        return
      }
    }
    await self.clients.openWindow(target)
  })())
})
