import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { api } from '../lib/api'
import type { Post, Site } from '../lib/types'
import { errorMessage } from '../lib/types'
import { createBrowserNotifications } from '../native/browser-notifications.js'

type ComposerRequest = { post: Post | null; origin: HTMLElement | null }
interface AppState {
  site: Site
  refresh: () => Promise<void>
  revision: number
  changed: () => void
  compose: (post?: Post | null, origin?: HTMLElement | null) => void
  composer: ComposerRequest | null
  closeComposer: () => void
  toast: (message: string) => void
  notifications: ReturnType<typeof createBrowserNotifications>
}
interface PostMenuState {
  postMenuId: number | null
  setPostMenuId: Dispatch<SetStateAction<number | null>>
}
const AppContext = createContext<AppState | null>(null)
const PostMenuContext = createContext<PostMenuState | null>(null)
export const useApp = () => {
  const value = useContext(AppContext)
  if (!value) throw new Error('应用尚未初始化')
  return value
}
export const usePostMenu = () => {
  const value = useContext(PostMenuContext)
  if (!value) throw new Error('应用尚未初始化')
  return value
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [site, setSite] = useState<Site | null>(null)
  const siteRef = useRef<Site | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [composer, setComposer] = useState<ComposerRequest | null>(null)
  const [postMenuId, setPostMenuId] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [notifications] = useState(() =>
    createBrowserNotifications({
      api,
      getRegistration: () => ('serviceWorker' in navigator ? navigator.serviceWorker.ready : null),
      getUser: () => siteRef.current?.user,
    }),
  )
  const refresh = useCallback(async () => {
    const next = await api<Site>('/api/site')
    siteRef.current = next
    setSite(next)
  }, [])
  const changed = useCallback(() => setRevision((n) => n + 1), [])
  const closeComposer = useCallback(() => setComposer(null), [])
  const compose = useCallback((post: Post | null = null, origin: HTMLElement | null = null) => {
    if (!siteRef.current?.user) {
      location.hash = '#/login'
      return
    }
    const source = origin || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setComposer((current) => current || { post, origin: source })
  }, [])
  const menuValue = useMemo(() => ({ postMenuId, setPostMenuId }), [postMenuId])
  const value = useMemo<AppState>(
    () => ({
      site: site!,
      refresh,
      revision,
      changed,
      compose,
      composer,
      closeComposer,
      toast: setMessage,
      notifications,
    }),
    [site, refresh, revision, changed, compose, composer, closeComposer, notifications],
  )
  useEffect(() => {
    const controller = new AbortController()
    api<Site>('/api/site', { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) {
          siteRef.current = next
          setSite(next)
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error))
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!site) return
    document.title = site.title
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', site.title)
  }, [site])
  useEffect(() => notifications.start(), [notifications])
  const userId = site?.user?.id
  useEffect(() => setPostMenuId(null), [userId])
  useEffect(() => {
    if (userId) void notifications.autoEnable().catch(() => {})
  }, [notifications, userId])
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(''), 5000)
    return () => clearTimeout(timer)
  }, [message])
  if (!site)
    return (
      <main className="container">
        <div className="empty-tip" role="status">
          {error || '正在打开日常…'}
          {error && <button onClick={() => location.reload()}>重新加载</button>}
        </div>
      </main>
    )
  return (
    <AppContext.Provider value={value}>
      <PostMenuContext.Provider value={menuValue}>
        {children}
        {message && (
          <div className="toast" role="status">
            {message}
            <button onClick={() => setMessage('')} aria-label="关闭提示">
              ×
            </button>
          </div>
        )}
      </PostMenuContext.Provider>
    </AppContext.Provider>
  )
}
