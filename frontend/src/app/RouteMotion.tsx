import { useLayoutEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { createViewScope } from '../native/views/scope.js'
import { enterSettingsView, settingsTransition } from '../native/ui/settings-motion.js'

export function RouteMotion() {
  const location = useLocation()
  const previous = useRef(location.pathname)
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = location.pathname
    const node = document.querySelector<HTMLElement>('.settings-page, .account-page')
    if (!node) return
    const scope = createViewScope()
    void enterSettingsView(node, scope, settingsTransition(`#${from}`, `#${location.pathname}`))
    return () => scope.dispose()
  }, [location.pathname])
  return null
}
