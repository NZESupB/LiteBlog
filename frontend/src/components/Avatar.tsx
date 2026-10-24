import { useEffect, useRef, useState } from 'react'
import { avatarColor } from '../native/utils.js'

interface AvatarProps {
  name: string | null | undefined
  url?: string | null
  className?: string
}

/** 所有头像共用同一套首字、加载和失败回退逻辑。 */
export function Avatar({ name, url = null, className = '' }: AvatarProps) {
  const displayName = name || '?'
  const initial = Array.from(displayName)[0] || '?'
  const image = useRef<HTMLImageElement>(null)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const status = !url ? 'fallback' : failedUrl === url ? 'error' : loadedUrl === url ? 'loaded' : 'loading'
  const showImage = Boolean(url) && status !== 'error'

  // 缓存图片可能在 effect 前已经完成，补读一次 naturalWidth，避免永远停在加载态。
  useEffect(() => {
    const node = image.current
    if (!url || !node?.complete) return
    if (node.naturalWidth > 0) setLoadedUrl(url)
    else setFailedUrl(url)
  }, [url])

  return (
    <span
      className={`avatar ${className}${showImage ? ' avatar-image' : ''}${status === 'loading' ? ' avatar-loading' : ''}${status === 'loaded' ? ' avatar-loaded' : ''}`}
      style={{ background: avatarColor(displayName) }}
      aria-hidden="true"
    >
      {initial}
      {showImage && (
        <img
          key={url}
          ref={image}
          src={url ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoadedUrl(url)}
          onError={() => setFailedUrl(url)}
        />
      )}
    </span>
  )
}
