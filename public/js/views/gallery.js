import { api, el, esc, parseTime, formatTime } from '../utils.js'
import { preloadInlineVideoPlayer } from '../inline-video.js'

// 相册只拥有自己的根节点；异步响应和错误都先核验所属视图。
export function createGalleryView({ scope, title, mediaTile, mediaTileAction, emptyJournal, onError }) {
  const node = el('<section class="gallery-page"></section>')
  const heading = el('<div class="page-heading"><div><p></p><h1>影像集</h1></div><span class="gallery-count"></span></div>')
  heading.querySelector('p').textContent = title
  node.appendChild(heading)
  void (async () => {
    try {
      const { images } = await api('/api/gallery', { signal: scope.signal })
      if (!scope.alive()) return
      const hasVideo = images.some((media) => media.type === 'video')
      heading.querySelector('.gallery-count').textContent = images.length ? `${images.length} ${hasVideo ? '项影像' : '张照片'}` : ''
      if (!images.length) {
        node.appendChild(emptyJournal('等待第一张，一起的照片', '留住眼前的风景，也留住那一刻的心情。', '/images/journal-cover.jpg'))
        return
      }
      const photos = images.filter((media) => media.type !== 'video')
      if (hasVideo) void preloadInlineVideoPlayer().catch((error) => { if (scope.alive()) onError(error.message) })
      const months = new Map()
      for (const media of images) {
        const date = parseTime(media.created_at)
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
        if (!months.has(key)) months.set(key, [])
        months.get(key).push(media)
      }
      for (const [key, items] of months) {
        const [year, month] = key.split('-')
        const section = el(`<section class="gallery-month"><h2 class="gallery-month-heading"><span>${year}年${Number(month)}月</span><span class="gallery-month-count">${items.length}</span></h2><div class="gallery-grid"></div></section>`)
        for (const media of items) {
          const caption = `${media.author} · ${formatTime(media.created_at)}`
          const tile = mediaTile(media)
          tile.classList.add('gallery-photo')
          tile.appendChild(el(`<span class="media-caption">${esc(caption)}</span>`))
          mediaTileAction(tile, media, photos).setAttribute('aria-label', `${media.type === 'video' ? '播放视频' : '查看照片'}：${caption}`)
          section.querySelector('.gallery-grid').appendChild(tile)
        }
        node.appendChild(section)
      }
    } catch (error) {
      if (scope.alive()) node.appendChild(el(`<div class="empty-tip">${esc(error.message)}</div>`))
    }
  })()
  return { node, dispose() { node.remove() } }
}
