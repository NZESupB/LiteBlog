import { useEffect } from 'react'
import { useApp } from './AppProviders'
import { errorMessage } from '../lib/types'

export function UpdatePrompt() {
  const { toast } = useApp()
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    let active = true
    let controlled = Boolean(navigator.serviceWorker.controller)
    let reloading = false
    let registration: ServiceWorkerRegistration | undefined
    let worker: ServiceWorker | null = null
    const reloadOnce = () => {
      if (!active || reloading) return
      reloading = true
      location.reload()
    }
    const inspect = () => {
      const waiting = registration?.waiting
      if (active && waiting && waiting.state !== 'redundant') waiting.postMessage({ type: 'SKIP_WAITING' })
    }
    const installed = () => {
      if (worker?.state === 'installed') inspect()
    }
    const found = () => {
      worker?.removeEventListener('statechange', installed)
      worker = registration?.installing || null
      worker?.addEventListener('statechange', installed)
      installed()
    }
    const changed = () => {
      const upgrading = controlled
      controlled = Boolean(navigator.serviceWorker.controller)
      if (upgrading && controlled) reloadOnce()
    }
    const report = (failure: unknown) => {
      if (active) toast(`离线资源更新失败：${errorMessage(failure)}`)
    }
    const check = async () => {
      if (!registration) return
      await registration.update()
      inspect()
    }
    const failed = (event: Event) => {
      const payload = (event as Event & { payload?: unknown }).payload
      const resource = errorMessage(payload) || location.href
      // 同一缺失资源在当前标签页只自动恢复一次；持续失败交还错误边界。
      try {
        const key = 'couple-blog-preload-recovery'
        const recovered = JSON.parse(sessionStorage.getItem(key) || '[]') as string[]
        if (recovered.includes(resource)) return
        sessionStorage.setItem(key, JSON.stringify([...recovered, resource]))
      } catch {
        return
      }
      event.preventDefault()
      void check().catch(report).finally(reloadOnce)
    }
    navigator.serviceWorker.addEventListener('controllerchange', changed)
    window.addEventListener('vite:preloadError', failed)
    void navigator.serviceWorker
      .register('/sw.js')
      .then((result) => {
        if (!active) return
        registration = result
        registration.addEventListener('updatefound', found)
        inspect()
        found()
      })
      .catch(report)
    const visible = () => {
      if (document.visibilityState === 'visible') void check().catch(report)
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      registration?.removeEventListener('updatefound', found)
      worker?.removeEventListener('statechange', installed)
      navigator.serviceWorker.removeEventListener('controllerchange', changed)
      window.removeEventListener('vite:preloadError', failed)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [toast])
  return null
}
