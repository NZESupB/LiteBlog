import { lazy, Suspense, useEffect, useRef } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from '../components/layout/Layout'
import { Timeline } from '../features/timeline/Timeline'
import { SinglePost, Gallery } from '../features/posts/Pages'
import { Account, Login } from '../features/session/Account'
import { Settings } from '../features/settings/Settings'
import { useApp } from './AppProviders'
import { UpdatePrompt } from './UpdatePrompt'
import { RouteMotion } from './RouteMotion'
const ComposerDialog = lazy(() => import('../features/composer/ComposerDialog'))
export function App() {
  const { composer, closeComposer } = useApp(),
    location = useLocation()
  const previousRoute = useRef(location.pathname)
  useEffect(() => {
    if (previousRoute.current !== location.pathname) closeComposer()
    previousRoute.current = location.pathname
  }, [location.pathname, closeComposer])
  useEffect(() => {
    if (!location.search.includes('comment=')) window.scrollTo({ top: 0, behavior: 'instant' })
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'notification-click')
        window.location.hash = `#/post/${event.data.postId}?comment=${event.data.commentId}`
    }
    navigator.serviceWorker?.addEventListener('message', handler)
    return () => navigator.serviceWorker?.removeEventListener('message', handler)
  }, [location.pathname, location.search])
  return (
    <>
      <RouteMotion />
      <UpdatePrompt />
      <Layout>
        <Routes>
          <Route path="/" element={<Timeline />} />
          <Route path="/post/:id" element={<SinglePost />} />
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/login" element={<Login />} />
          <Route path="/account" element={<Account />} />
          <Route path="/settings/profile" element={<Account />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/:section" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
      {composer && (
        <Suspense
          fallback={
            <div className="toast" role="status">
              正在打开写作面板…
            </div>
          }
        >
          <ComposerDialog post={composer.post} origin={composer.origin} />
        </Suspense>
      )}
    </>
  )
}
