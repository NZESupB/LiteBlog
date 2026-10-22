import { useEffect, useRef } from 'react'
import { Play, X } from 'lucide-react'
import type { Media } from '../../lib/types'
import { useApp } from '../../app/AppProviders'
import { playInlineVideo, stopInlineVideo, preloadInlineVideoPlayer } from '../../native/inline-video.js'
import { openLightbox, closeLightbox } from '../../native/lightbox.js'

export function MediaGrid({ items, gallery = false }: { items: Media[]; gallery?: boolean }) {
  const { toast } = useApp()
  const hasVideo = items.some((item) => item.type === 'video')
  useEffect(() => {
    if (hasVideo) void preloadInlineVideoPlayer().catch((error: Error) => toast(error.message))
    return () => {
      stopInlineVideo()
      closeLightbox(true)
    }
  }, [hasVideo, toast])
  if (!items.length) return null
  return (
    <div className={gallery ? 'gallery-grid' : `img-grid n${items.length}`}>
      {items.map((item) => (
        <MediaTile
          key={item.id || item.url}
          item={item}
          gallery={gallery}
          photos={items.filter((media) => media.type !== 'video')}
        />
      ))}
    </div>
  )
}
function MediaTile({ item, photos, gallery }: { item: Media; photos: Media[]; gallery: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const { toast } = useApp()
  const video = item.type === 'video',
    poster = video ? item.poster : item.url
  return (
    <div
      ref={ref}
      className={`media-tile${gallery ? ' gallery-photo' : ''}${video ? ' is-video' : ''}${poster ? '' : ' no-poster'}`}
      data-media-url={item.url}
    >
      {poster && <img src={poster} alt="" loading="lazy" />}
      {video && (
        <>
          <span className="media-play" aria-hidden="true">
            <Play className="icon" />
          </span>
          {item.duration && (
            <span className="media-duration">
              {Math.floor(item.duration / 60)}:{String(Math.floor(item.duration % 60)).padStart(2, '0')}
            </span>
          )}
        </>
      )}
      {item.live && (
        <span className="media-live" aria-hidden="true">
          <span className="lb-live-dot" />
          LIVE
        </span>
      )}
      {gallery && <span className="media-caption">{item.author}</span>}
      <button
        className="media-hit"
        aria-label={video ? '播放视频' : '查看照片'}
        onClick={(event) => {
          if (video)
            playInlineVideo(ref.current, item, {
              onError: () => toast('浏览器或设备无法解码此视频，请尝试支持 HEVC 的浏览器或设备'),
            })
          else {
            stopInlineVideo()
            openLightbox(photos, photos.indexOf(item), event.currentTarget)
          }
        }}
      />
      {video && (
        <>
          <div className="media-player" hidden />
          <button className="media-collapse" aria-label="收起视频" hidden onClick={() => stopInlineVideo()}>
            <X className="icon" />
          </button>
        </>
      )}
    </div>
  )
}
