import { useEffect, useRef, useState } from 'react'
import { json } from '../../lib/api'
import { errorMessage } from '../../lib/types'
import { useResource } from '../../lib/use-resource'

interface Config {
  mode: string
  shared: { baseUrl: string; model: string; hasApiKey: boolean }
  sharedModel: string
  custom: { baseUrl: string; model: string; hasApiKey: boolean }
  thinking?: string
}
type ConfigMode = 'shared' | 'custom'
export function ApiConfigCard({
  path,
  title,
  thinking = false,
}: {
  path: string
  title: string
  thinking?: boolean
}) {
  const { data, error, loading } = useResource<Config>(path)
  if (loading) return <p role="status">正在读取{title}…</p>
  if (error) return <p role="alert">{error}</p>
  return data && <ConfigForm key={path} initial={data} path={path} title={title} thinking={thinking} />
}
function ConfigForm({
  initial,
  path,
  title,
  thinking,
}: {
  initial: Config
  path: string
  title: string
  thinking: boolean
}) {
  const form = useRef<HTMLFormElement>(null)
  const [mode, setMode] = useState<ConfigMode>(initial.mode === 'custom' ? 'custom' : 'shared')
  const [models, setModels] = useState<Record<ConfigMode, string[]>>({ shared: [], custom: [] })
  const [messages, setMessages] = useState<Record<ConfigMode, string>>({ shared: '', custom: '' })
  const [messageOk, setMessageOk] = useState<Record<ConfigMode, boolean>>({ shared: false, custom: false })
  const [busy, setBusy] = useState(false)
  const sourceVersions = useRef({ shared: 0, custom: 0 })
  const changeSource = (kind: ConfigMode) => {
    ++sourceVersions.current[kind]
    setModels((current) => ({ ...current, [kind]: [] }))
    setMessages((current) => ({ ...current, [kind]: '' }))
  }
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    controller.current = new AbortController()
    return () => controller.current?.abort()
  }, [])
  const payload = () => {
    const values = new FormData(form.current!)
    const result: Record<string, unknown> =
      mode === 'shared'
        ? {
            mode,
            model: values.get('sharedModel'),
            sharedBaseUrl: values.get('sharedBaseUrl'),
            sharedApiKey: values.get('sharedApiKey'),
          }
        : {
            mode,
            model: values.get('customModel'),
            baseUrl: values.get('baseUrl'),
            apiKey: values.get('apiKey'),
          }
    if (thinking) result.thinking = values.get('thinking')
    return result
  }
  const action = async (kind: 'save' | 'models' | 'test') => {
    if (busy) return
    const current = controller.current!
    const requestedMode = mode
    const sourceVersion = sourceVersions.current[requestedMode]
    const submitted = payload()
    const keyName = requestedMode === 'shared' ? 'sharedApiKey' : 'apiKey'
    const submittedKey = String(submitted[keyName] || '').trim()
    const setMessage = (text: string, ok = true) => {
      setMessages((previous) => ({ ...previous, [requestedMode]: text }))
      setMessageOk((previous) => ({ ...previous, [requestedMode]: ok }))
    }
    setBusy(true)
    setMessage('')
    try {
      const result = await json<{ models?: string[]; message?: string; ok?: boolean }>(
        kind === 'save' ? path : `${path}/${kind}`,
        kind === 'save' ? 'PUT' : 'POST',
        submitted,
        current.signal,
      )
      if (current.signal.aborted) return
      if (kind === 'models') {
        if (sourceVersions.current[requestedMode] !== sourceVersion) return
        const names = [...new Set(result.models || [])]
        setModels((previous) => ({ ...previous, [requestedMode]: names }))
        setMessage(names.length ? `已获取 ${names.length} 个模型` : '接口未返回模型列表')
      } else if (kind === 'save') {
        const input = form.current!.elements.namedItem(keyName) as HTMLInputElement
        if (
          submittedKey &&
          sourceVersions.current[requestedMode] === sourceVersion &&
          input.value.trim() === submittedKey
        ) {
          input.value = ''
          input.placeholder = '已保存，留空表示不修改'
        }
        setMessage('已保存')
      } else
        setMessage(result.message || (result.ok === false ? '接口连接失败' : '连接成功'), result.ok !== false)
    } catch (error) {
      if (!current.signal.aborted) setMessage(errorMessage(error), false)
    } finally {
      if (!current.signal.aborted) setBusy(false)
    }
  }
  return (
    <form
      ref={form}
      className="card settings-card api-config-card"
      onSubmit={(event) => {
        event.preventDefault()
        void action('save')
      }}
    >
      <div className="settings-card-heading">
        <div>
          <h2>{title}</h2>
          <p>凭据只存服务器，留空表示沿用已保存密钥。</p>
        </div>
      </div>
      <div className="api-source-selector" role="radiogroup" aria-label={`${title}配置来源`}>
        {(['shared', 'custom'] as const).map((value) => (
          <label className="api-source-option" key={value}>
            <input
              type="radio"
              name={`${path}-mode`}
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            <span>{value === 'shared' ? '使用共享 API' : '使用独立 API'}</span>
          </label>
        ))}
      </div>
      {(['shared', 'custom'] as const).map((kind) => (
        <div className="api-source-fields" key={kind} hidden={mode !== kind} inert={mode !== kind}>
          <label>
            接口地址
            <input
              name={kind === 'shared' ? 'sharedBaseUrl' : 'baseUrl'}
              defaultValue={initial[kind].baseUrl}
              placeholder="https://…/v1"
              onInput={() => changeSource(kind)}
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              name={kind === 'shared' ? 'sharedApiKey' : 'apiKey'}
              autoComplete="new-password"
              placeholder={initial[kind].hasApiKey ? '已保存，留空表示不修改' : '填写 API Key'}
              onInput={() => changeSource(kind)}
            />
          </label>
          <label>
            模型
            <input
              name={kind === 'shared' ? 'sharedModel' : 'customModel'}
              defaultValue={kind === 'shared' ? initial.sharedModel : initial.custom.model}
            />
            {!!models[kind].length && (
              <select
                aria-label={`选择${title}模型`}
                value=""
                onChange={(event) => {
                  const name = kind === 'shared' ? 'sharedModel' : 'customModel'
                  const input = form.current!.elements.namedItem(name) as HTMLInputElement
                  if (event.target.value) input.value = event.target.value
                }}
              >
                <option value="">选择获取到的模型</option>
                {models[kind].map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            )}
          </label>
        </div>
      ))}
      {thinking && (
        <label>
          思考强度
          <select name="thinking" defaultValue={initial.thinking || ''}>
            <option value="">不指定（跟随模型默认）</option>
            <option value="middle">中</option>
            <option value="high">高</option>
            <option value="max">最高</option>
          </select>
        </label>
      )}
      <div className="settings-actions">
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => action('models')}>
          自动获取模型
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => action('test')}>
          测试连接
        </button>
        <button className="btn" disabled={busy}>
          保存
        </button>
      </div>
      <p
        className="form-message"
        data-state={messageOk[mode] ? 'success' : 'error'}
        role={messageOk[mode] ? 'status' : 'alert'}
      >
        {messages[mode]}
      </p>
    </form>
  )
}
