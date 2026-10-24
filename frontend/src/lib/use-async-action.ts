import { useCallback, useState } from 'react'
import { errorMessage } from './types'

// 设置表单共用的提交状态机：busy + 成功/失败消息。
// 需要在失败时做额外处理（如回滚控件）的调用方，在 action 内部处理后 rethrow。
export function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [ok, setOk] = useState(false)
  const run = async (action: () => Promise<string | void>) => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      setMessage((await action()) || '')
      setOk(true)
    } catch (error) {
      setMessage(errorMessage(error))
      setOk(false)
    } finally {
      setBusy(false)
    }
  }
  // fail 供轮询等 effect 内上报外部错误，引用必须稳定。
  const fail = useCallback((text: string) => {
    setMessage(text)
    setOk(false)
  }, [])
  return { busy, message, ok, run, fail }
}
