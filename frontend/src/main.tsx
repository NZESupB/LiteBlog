import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { AppProviders } from './app/AppProviders'
import { ErrorBoundary } from './app/ErrorBoundary'
import { App } from './app/App'
import './styles/react.css'
import { installPressMotion } from './native/ui/motion.js'

installPressMotion()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <AppProviders>
          <App />
        </AppProviders>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>,
)
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
}
