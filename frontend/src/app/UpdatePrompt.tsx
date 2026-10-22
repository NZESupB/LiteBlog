import { useEffect, useRef, useState } from 'react'
import { useApp } from './AppProviders'

export function UpdatePrompt() {
  const { composer } = useApp()
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const requested = useRef(false)
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    let active = true
    let registration: ServiceWorkerRegistration | undefined
    let worker: ServiceWorker | null = null
    const inspect = () => {
      if (active && registration?.waiting) setWaiting(registration.waiting)
    }
    const installed = () => {
      if (worker?.state === 'installed') inspect()
    }
    const found = () => {
      worker?.removeEventListener('statechange', installed)
      worker = registration?.installing || null
      worker?.addEventListener('statechange', installed)
    }
    const changed = () => {
      if (requested.current) location.reload()
      else setWaiting(null)
    }
    const failed = (event: Event) => {
      event.preventDefault()
      setStale(true)
    }
    navigator.serviceWorker.addEventListener('controllerchange', changed)
    window.addEventListener('vite:preloadError', failed)
    void navigator.serviceWorker
      .register('/sw.js')
      .then((result) => {
        if (!active) return
        registration = result
        inspect()
        found()
        registration.addEventListener('updatefound', found)
      })
      .catch((failure: Error) => {
        if (active) setError(`离线资源更新失败：${failure.message}`)
      })
    const check = () => {
      if (document.visibilityState === 'visible') void registration?.update().catch(() => {})
    }
    document.addEventListener('visibilitychange', check)
    return () => {
      active = false
      registration?.removeEventListener('updatefound', found)
      worker?.removeEventListener('statechange', installed)
      navigator.serviceWorker.removeEventListener('controllerchange', changed)
      window.removeEventListener('vite:preloadError', failed)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  if (!waiting && !stale && !error) return null
  return (
    <aside className="update-prompt" role="status">
      <span>
        {error || (composer ? '新版本已就绪，关闭写作面板后即可更新。' : '新版本已就绪，草稿会保留。')}
      </span>
      {!error && (
        <button
          className="btn-ghost"
          disabled={Boolean(composer) || busy}
          onClick={() => {
            setBusy(true)
            if (waiting && waiting.state !== 'redundant') {
              requested.current = true
              waiting.postMessage({ type: 'SKIP_WAITING' })
            } else location.reload()
          }}
        >
          {busy ? '正在更新…' : '更新并重新加载'}
        </button>
      )}
      {error && (
        <button className="btn-ghost" onClick={() => setError('')}>
          关闭提示
        </button>
      )}
    </aside>
  )
}
