import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../../app/AppProviders'
import { api, json } from '../../lib/api'
import { errorMessage } from '../../lib/types'
import { openAvatarCropper } from '../../native/ui/avatar-cropper.js'
import { createViewScope } from '../../native/views/scope.js'
import { SettingsPage } from '../../components/layout/SettingsPage'

export function Login() {
  const { site, refresh, changed } = useApp(),
    navigate = useNavigate()
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  if (site.user) return <Navigate to="/" replace />
  return (
    <section className="card auth-card">
      <p className="eyebrow">WELCOME HOME</p>
      <h1>欢迎回来</h1>
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (busy) return
          const values = new FormData(event.currentTarget)
          setBusy(true)
          setError('')
          try {
            await json('/api/login', 'POST', Object.fromEntries(values))
            await refresh()
            changed()
            navigate('/', { replace: true })
          } catch (error) {
            setError(errorMessage(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          登录账号
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          密码
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <p role="alert" className="form-error">
          {error}
        </p>
        <button className="btn" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </section>
  )
}
export function Account() {
  const { site, refresh, toast } = useApp(),
    location = useLocation()
  const [messages, setMessages] = useState<Record<string, { text: string; ok: boolean }>>({}),
    [busy, setBusy] = useState(''),
    [avatarBusy, setAvatarBusy] = useState(false)
  const scope = useRef<ReturnType<typeof createViewScope> | null>(null)
  const avatarInput = useRef<HTMLInputElement>(null)
  const avatarButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    scope.current = createViewScope()
    return () => scope.current?.dispose()
  }, [])
  if (!site.user) return <Navigate to="/login" replace />
  const user = site.user
  const settings = location.pathname === '/settings/profile'
  const backTo =
    location.state?.returnTo === '/settings' || location.state?.returnTo === '/'
      ? location.state.returnTo
      : settings
        ? '/settings'
        : '/'
  const submit = async (event: FormEvent<HTMLFormElement>, path: string) => {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    setBusy(path)
    setMessages((previous) => ({ ...previous, [path]: { text: '', ok: false } }))
    try {
      await json(path, 'POST', Object.fromEntries(new FormData(form)))
      if (path === '/api/profile') await refresh()
      else form.reset()
      setMessages((previous) => ({
        ...previous,
        [path]: { text: path === '/api/profile' ? '资料已保存' : '密码已修改', ok: true },
      }))
    } catch (error) {
      setMessages((previous) => ({ ...previous, [path]: { text: errorMessage(error), ok: false } }))
    } finally {
      setBusy('')
    }
  }
  return (
    <SettingsPage
      account
      title="账号设置"
      description="管理头像、个人资料与登录密码。"
      backTo={backTo}
      backLabel={backTo === '/settings' ? '设置' : '时间轴'}
    >
      <section className="card settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>头像</h2>
            <p>选择一张照片，裁剪后作为你的头像。</p>
          </div>
        </div>
        <div className="account-avatar-row">
          <span className="avatar">
            {user.avatarUrl ? <img src={user.avatarUrl} alt={user.name} /> : user.name.slice(0, 1)}
          </span>
          <button
            ref={avatarButton}
            className="btn-ghost"
            type="button"
            disabled={avatarBusy}
            onClick={() => avatarInput.current?.click()}
          >
            更换头像
          </button>
          <input
            ref={avatarInput}
            aria-label="头像文件"
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (!file) return
              avatarButton.current?.focus({ preventScroll: true })
              openAvatarCropper(
                file,
                async (blob: Blob) => {
                  setAvatarBusy(true)
                  try {
                    const form = new FormData()
                    form.append('avatar', blob, 'avatar.jpg')
                    await api('/api/profile/avatar', { method: 'POST', body: form })
                    await refresh()
                    toast('头像已更新')
                    return true
                  } finally {
                    setAvatarBusy(false)
                  }
                },
                () => {},
                scope.current,
              )
            }}
          />
          {user.avatarUrl && (
            <button
              type="button"
              disabled={avatarBusy}
              className="btn-ghost"
              onClick={async () => {
                if (avatarBusy) return
                setAvatarBusy(true)
                try {
                  await api('/api/profile/avatar', { method: 'DELETE' })
                  await refresh()
                  avatarButton.current?.focus({ preventScroll: true })
                  toast('头像已移除')
                } catch (error) {
                  toast(errorMessage(error))
                } finally {
                  setAvatarBusy(false)
                }
              }}
            >
              移除头像
            </button>
          )}
        </div>
      </section>
      <form className="card settings-card" onSubmit={(event) => submit(event, '/api/profile')}>
        <div className="settings-card-heading">
          <div>
            <h2>个人资料</h2>
            <p>登录账号用于登录，显示名称会出现在日常与评论中。</p>
          </div>
        </div>
        <label>
          登录账号
          <input name="username" defaultValue={user.username} maxLength={24} required />
        </label>
        <label>
          显示名称
          <input name="displayName" defaultValue={user.displayName || user.name} maxLength={24} required />
        </label>
        <div className="settings-actions">
          <button className="btn" disabled={Boolean(busy)}>
            {busy === '/api/profile' ? '保存中…' : '保存资料'}
          </button>
        </div>
        {messages['/api/profile']?.text && (
          <p
            className="form-message"
            data-state={messages['/api/profile'].ok ? 'success' : 'error'}
            role={messages['/api/profile'].ok ? 'status' : 'alert'}
          >
            {messages['/api/profile'].text}
          </p>
        )}
      </form>
      <form className="card settings-card" onSubmit={(event) => submit(event, '/api/password')}>
        <div className="settings-card-heading">
          <div>
            <h2>修改密码</h2>
            <p>新密码至少 6 位，请使用与其他网站不同的密码。</p>
          </div>
        </div>
        <label>
          原密码
          <input name="oldPassword" type="password" autoComplete="current-password" required />
        </label>
        <label>
          新密码
          <input name="newPassword" type="password" autoComplete="new-password" minLength={6} required />
        </label>
        <div className="settings-actions">
          <button className="btn" disabled={Boolean(busy)}>
            {busy === '/api/password' ? '修改中…' : '修改密码'}
          </button>
        </div>
        {messages['/api/password']?.text && (
          <p
            className="form-message"
            data-state={messages['/api/password'].ok ? 'success' : 'error'}
            role={messages['/api/password'].ok ? 'status' : 'alert'}
          >
            {messages['/api/password'].text}
          </p>
        )}
      </form>
      {!settings && (
        <Link className="account-settings-link" to="/settings">
          管理站点设置
        </Link>
      )}
    </SettingsPage>
  )
}
