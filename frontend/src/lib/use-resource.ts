import { useEffect, useState } from 'react'
import { api } from './api'
import { errorMessage } from './types'

export function useResource<T>(path: string, revision = 0) {
  const [state, setState] = useState<{ path: string; data?: T; error: string; loading: boolean }>({
    path,
    error: '',
    loading: true,
  })
  useEffect(() => {
    const controller = new AbortController()
    setState({ path, error: '', loading: true })
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ path, data, error: '', loading: false })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ path, error: errorMessage(error), loading: false })
      })
    return () => controller.abort()
  }, [path, revision])
  return state.path === path ? state : { path, error: '', loading: true }
}
